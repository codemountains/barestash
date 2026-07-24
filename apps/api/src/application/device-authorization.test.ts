import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredAccount } from "../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import {
  createDeviceAuthorization,
  pollDeviceAuthorizationToken,
} from "./device-authorization.js";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const DEVICE_CODE = `bst_device_${"d".repeat(32)}`;
const ACCESS_TOKEN = formatBearerTokenString({
  type: "access",
  tokenIdSuffix: "ABCDEFGHIJKLMNOPQRSTUVWX",
  secret: "a".repeat(32),
});
const REFRESH_TOKEN = formatBearerTokenString({
  type: "refresh",
  tokenIdSuffix: "ZYXWVUTSRQPONMLKJIHGFEDC",
  secret: "r".repeat(32),
});

describe("Device Authorization use cases", () => {
  let repository: InMemoryAuthDomainRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount(account());
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects unknown scopes before issuing codes", async () => {
    let codeGenerationCount = 0;

    const result = await createDeviceAuthorization({
      ...creationDeps(),
      repository,
      body: {
        client_name: "barestash-cli",
        requested_scopes: ["events:read", "unknown:scope"],
      },
      makeDeviceCode: () => {
        codeGenerationCount += 1;
        return DEVICE_CODE;
      },
    });

    expect(result).toMatchObject({ kind: "error", code: "invalid_request" });
    expect(codeGenerationCount).toBe(0);
  });

  it("stores only hashes and returns normalized ten-minute codes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await createDeviceAuthorization({
      ...creationDeps(),
      repository,
    });

    expect(result).toMatchObject({
      kind: "ok",
      value: {
        device_code: DEVICE_CODE,
        user_code: "ABCD-EFGH",
        verification_uri: "https://app.example.com/device",
        verification_uri_complete:
          "https://app.example.com/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      },
    });
    const stored = await repository.findDeviceAuthorizationByDeviceCodeHash(
      await credentialHash(DEVICE_CODE),
    );
    expect(stored).toMatchObject({
      status: "pending",
      requested_scopes: ["events:read", "mcp:use"],
      expires_at: "2026-07-13T00:10:00.000Z",
      poll_interval_seconds: 5,
    });
    expect(JSON.stringify(stored)).not.toContain(DEVICE_CODE);
    expect(JSON.stringify(stored)).not.toContain("ABCD-EFGH");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.device_authorization.created",
        device_authorization_id: "dva_test",
      }),
    );
    expect(log.mock.calls.join("\n")).not.toContain(DEVICE_CODE);
    expect(log.mock.calls.join("\n")).not.toContain("ABCD-EFGH");
  });

  it("retries with a fresh user code when a retained code collides", async () => {
    await createDeviceAuthorization({
      ...creationDeps(),
      repository,
    });
    const makeUserCode = vi
      .fn<() => string>()
      .mockReturnValueOnce("ABCDEFGH")
      .mockReturnValueOnce("JKMNPQRS");

    const result = await createDeviceAuthorization({
      ...creationDeps(),
      repository,
      makeDeviceAuthorizationId: () => "dva_retry",
      makeDeviceCode: () => `bst_device_${"e".repeat(32)}`,
      makeUserCode,
    });

    expect(result).toMatchObject({
      kind: "ok",
      value: { user_code: "JKMN-PQRS" },
    });
    expect(makeUserCode).toHaveBeenCalledTimes(2);
  });

  it("fails after bounded user code collision retries", async () => {
    await createDeviceAuthorization({
      ...creationDeps(),
      repository,
    });
    const makeUserCode = vi.fn(() => "ABCDEFGH");

    const result = await createDeviceAuthorization({
      ...creationDeps(),
      repository,
      makeDeviceAuthorizationId: () => "dva_exhausted",
      makeDeviceCode: () => `bst_device_${"f".repeat(32)}`,
      makeUserCode,
    });

    expect(result).toMatchObject({ kind: "error", code: "internal_error" });
    expect(makeUserCode).toHaveBeenCalledTimes(5);
  });

  it("does not retry repository failures unrelated to user code conflicts", async () => {
    const databaseError = new Error("database unavailable");
    const create = vi
      .spyOn(repository, "createDeviceAuthorization")
      .mockRejectedValue(databaseError);
    const makeUserCode = vi.fn(() => "ABCDEFGH");

    await expect(
      createDeviceAuthorization({
        ...creationDeps(),
        repository,
        makeUserCode,
      }),
    ).rejects.toBe(databaseError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(makeUserCode).toHaveBeenCalledTimes(1);
  });

  it("returns pending, then slow_down for concurrent or early polling", async () => {
    await createPendingAuthorization();

    const first = await poll(NOW);
    const concurrent = await poll(NOW);
    const early = await poll(new Date(NOW.getTime() + 4_999));

    expect(first).toMatchObject({
      kind: "error",
      code: "authorization_pending",
    });
    expect(concurrent).toMatchObject({ kind: "error", code: "slow_down" });
    expect(early).toMatchObject({ kind: "error", code: "slow_down" });
  });

  it.each([
    ["denied", "authorization_denied"],
    ["expired", "device_code_expired"],
  ] as const)("returns %s state as a structured error", async (status, code) => {
    const created = await createPendingAuthorization();
    if (status === "denied") {
      await repository.denyDeviceAuthorization(created.id, NOW.toISOString());
    } else {
      await repository.expireDeviceAuthorization(created.id);
    }

    await expect(poll(NOW)).resolves.toMatchObject({ kind: "error", code });
  });

  it("returns invalid_device_code without revealing lookup details", async () => {
    const result = await pollDeviceAuthorizationToken({
      ...pollDeps(NOW),
      repository,
      deviceCode: `bst_device_${"x".repeat(32)}`,
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "invalid_device_code",
    });
  });

  it("exchanges an approval once with exactly the requested scopes", async () => {
    const created = await createPendingAuthorization();
    await repository.approveDeviceAuthorization(
      created.id,
      "acc_test",
      NOW.toISOString(),
    );

    const firstPollAt = new Date(NOW.getTime() + 5 * 60 * 1_000);
    const first = await poll(firstPollAt);
    const second = await poll(new Date(firstPollAt.getTime() + 5_000));

    expect(first).toMatchObject({
      kind: "ok",
      value: {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_775_700,
        scopes: ["events:read", "mcp:use"],
      },
    });
    expect(second).toMatchObject({
      kind: "error",
      code: "device_code_consumed",
    });
    await expect(
      repository.findCliSessionById("cls_test"),
    ).resolves.toMatchObject({
      scopes: ["events:read", "mcp:use"],
      idle_expires_at: "2026-08-12T00:00:00.000Z",
      absolute_expires_at: "2026-10-11T00:00:00.000Z",
    });
  });

  it("returns account_disabled when the atomic exchange rejects the account", async () => {
    const created = await createPendingAuthorization();
    await repository.approveDeviceAuthorization(
      created.id,
      "acc_test",
      NOW.toISOString(),
    );
    vi.spyOn(repository, "exchangeDeviceAuthorization").mockResolvedValueOnce(
      "account_disabled",
    );

    const result = await poll(new Date(NOW.getTime() + 5 * 60 * 1_000));

    expect(result).toMatchObject({
      kind: "error",
      code: "account_disabled",
    });
  });

  async function createPendingAuthorization() {
    const result = await createDeviceAuthorization({
      ...creationDeps(),
      repository,
    });
    if (result.kind === "error") throw new Error(result.message);
    const stored = await repository.findDeviceAuthorizationByDeviceCodeHash(
      await credentialHash(result.value.device_code),
    );
    if (stored === null)
      throw new Error("Device Authorization was not stored.");
    return stored;
  }

  function poll(now: Date) {
    return pollDeviceAuthorizationToken({
      ...pollDeps(now),
      repository,
      deviceCode: DEVICE_CODE,
    });
  }
});

function creationDeps() {
  return {
    repository: new InMemoryAuthDomainRepository(),
    now: NOW,
    credentialPepper: "pepper",
    verificationUri: "https://app.example.com/device",
    body: {
      client_name: "barestash-cli",
      client_version: "0.1.0",
      device_name: "test-device",
      requested_scopes: ["events:read", "mcp:use"],
    },
    makeDeviceAuthorizationId: () => "dva_test" as const,
    makeDeviceCode: () => DEVICE_CODE,
    makeUserCode: () => "abcd-efgh",
  };
}

function pollDeps(now: Date) {
  return {
    now,
    credentialPepper: "pepper",
    makeCliSessionId: () => "cls_test" as const,
    makeAccessTokenId: () => "atk_ABCDEFGHIJKLMNOPQRSTUVWX" as const,
    makeRefreshTokenId: () => "rtk_ZYXWVUTSRQPONMLKJIHGFEDC" as const,
    makeAccessToken: () => ACCESS_TOKEN,
    makeRefreshToken: () => REFRESH_TOKEN,
  };
}

async function credentialHash(value: string) {
  const { hashCredential } = await import("./credential-hash.js");
  return hashCredential(value, { pepper: "pepper" });
}

function account(): StoredAccount {
  return {
    id: "acc_test",
    primary_email: "user@example.com",
    display_name: "Test User",
    avatar_url: null,
    status: "active",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}
