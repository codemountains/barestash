import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import type { RefreshTokenId } from "@barestash/shared/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StoredAccessToken,
  StoredAccount,
  StoredCliSession,
  StoredRefreshToken,
} from "../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import { refreshCliSession, revokeCliSession } from "./cli-session.js";
import { hashCredential } from "./credential-hash.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const OLD_REFRESH_ID = "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const NEW_REFRESH_ID = "rtk_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
const NEW_ACCESS_ID = "atk_BCDEFGHIJKLMNOPQRSTUVWXY" as const;
const OLD_REFRESH = formatBearerTokenString({
  type: "refresh",
  tokenIdSuffix: OLD_REFRESH_ID.slice(4),
  secret: "r".repeat(32),
});
const NEW_REFRESH = formatBearerTokenString({
  type: "refresh",
  tokenIdSuffix: NEW_REFRESH_ID.slice(4),
  secret: "n".repeat(32),
});
const NEW_ACCESS = formatBearerTokenString({
  type: "access",
  tokenIdSuffix: NEW_ACCESS_ID.slice(4),
  secret: "a".repeat(32),
});

describe("CLI session lifecycle", () => {
  let repository: InMemoryAuthDomainRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount(account());
    await repository.createCliSession(session());
    await repository.createRefreshToken(await oldRefreshToken());
  });

  afterEach(() => vi.restoreAllMocks());

  it("rotates a refresh token and extends only the idle expiration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await refreshCliSession({
      repository,
      refreshToken: OLD_REFRESH,
      now: NOW,
      makeAccessTokenId: () => NEW_ACCESS_ID,
      makeRefreshTokenId: () => NEW_REFRESH_ID,
      makeAccessToken: () => NEW_ACCESS,
      makeRefreshToken: () => NEW_REFRESH,
    });

    expect(result).toEqual({
      kind: "ok",
      value: {
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
      },
    });
    expect(await repository.findRefreshTokenById(OLD_REFRESH_ID)).toMatchObject(
      {
        status: "used",
        replaced_by_token_id: NEW_REFRESH_ID,
        used_at: NOW.toISOString(),
      },
    );
    expect(await repository.findRefreshTokenById(NEW_REFRESH_ID)).toMatchObject(
      {
        status: "active",
        parent_token_id: OLD_REFRESH_ID,
        token_family_id: "family-test",
      },
    );
    expect(await repository.findCliSessionById("cls_test")).toMatchObject({
      status: "active",
      last_used_at: NOW.toISOString(),
      idle_expires_at: "2026-08-13T00:00:00.000Z",
      absolute_expires_at: "2026-10-12T00:00:00.000Z",
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.access_token.refreshed",
        account_id: "acc_test",
        session_id: "cls_test",
        access_token_id: NEW_ACCESS_ID,
        refresh_token_id: NEW_REFRESH_ID,
      }),
    );
    expect(log.mock.calls.join("\n")).not.toContain(NEW_ACCESS);
    expect(log.mock.calls.join("\n")).not.toContain(NEW_REFRESH);
  });

  it("marks the whole session family compromised when a used refresh token is reused", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCliSession({
      repository,
      refreshToken: OLD_REFRESH,
      now: NOW,
      makeAccessTokenId: () => NEW_ACCESS_ID,
      makeRefreshTokenId: () => NEW_REFRESH_ID,
      makeAccessToken: () => NEW_ACCESS,
      makeRefreshToken: () => NEW_REFRESH,
    });

    const result = await refreshCliSession({
      repository,
      refreshToken: OLD_REFRESH,
      now: new Date("2026-07-14T00:00:01.000Z"),
      makeAccessTokenId: () => "atk_CDEFGHIJKLMNOPQRSTUVWXYZ",
      makeRefreshTokenId: () =>
        "rtk_CDEFGHIJKLMNOPQRSTUVWXYZ" as RefreshTokenId,
      makeAccessToken: () => "unused",
      makeRefreshToken: () => "unused",
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "refresh_token_reuse_detected",
      status: 401,
    });
    expect(await repository.findCliSessionById("cls_test")).toMatchObject({
      status: "compromised",
      compromised_at: "2026-07-14T00:00:01.000Z",
    });
    expect(await repository.findRefreshTokenById(NEW_REFRESH_ID)).toMatchObject(
      { status: "revoked" },
    );
    expect(await repository.findRefreshTokenById(OLD_REFRESH_ID)).toMatchObject(
      { status: "revoked" },
    );
    expect(await repository.findAccessTokenById(NEW_ACCESS_ID)).toMatchObject({
      status: "revoked",
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.cli_session.compromised",
        account_id: "acc_test",
        session_id: "cls_test",
      }),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.refresh_token.reuse_detected",
        account_id: "acc_test",
        session_id: "cls_test",
        refresh_token_id: OLD_REFRESH_ID,
      }),
    );
  });

  it.each([
    ["idle_expires_at", "2026-07-14T00:00:00.000Z"],
    ["absolute_expires_at", "2026-07-14T00:00:00.000Z"],
  ] as const)("rejects a session past %s", async (field, value) => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount(account());
    await repository.createCliSession({ ...session(), [field]: value });
    await repository.createRefreshToken(await oldRefreshToken());

    const result = await refreshCliSession(refreshInput(repository));

    expect(result).toMatchObject({
      kind: "error",
      code: "session_expired",
      status: 401,
    });
  });

  it("rejects refresh for a disabled account", async () => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount({ ...account(), status: "disabled" });
    await repository.createCliSession(session());
    await repository.createRefreshToken(await oldRefreshToken());

    const result = await refreshCliSession(refreshInput(repository));

    expect(result).toMatchObject({
      kind: "error",
      code: "account_disabled",
      status: 401,
    });
  });

  it("revokes a CLI session and every token idempotently", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await repository.createAccessToken(accessToken());

    const first = await revokeCliSession({
      repository,
      sessionId: "cls_test",
      now: NOW,
    });
    const second = await revokeCliSession({
      repository,
      sessionId: "cls_test",
      now: new Date("2026-07-14T00:01:00.000Z"),
    });

    expect(first).toMatchObject({
      kind: "ok",
      value: { session: { id: "cls_test", status: "revoked" } },
    });
    expect(second).toEqual(first);
    expect(
      await repository.findAccessTokenById("atk_ABCDEFGHIJKLMNOPQRSTUVWX"),
    ).toMatchObject({ status: "revoked" });
    expect(await repository.findRefreshTokenById(OLD_REFRESH_ID)).toMatchObject(
      { status: "revoked" },
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.cli_session.revoked",
        account_id: "acc_test",
        session_id: "cls_test",
      }),
    );
  });
});

function account(): StoredAccount {
  return {
    id: "acc_test",
    primary_email: "user@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function session(): StoredCliSession {
  return {
    id: "cls_test",
    account_id: "acc_test",
    device_name: "test-device",
    client_version: "0.0.0",
    status: "active",
    scopes: ["events:read"],
    created_at: "2026-07-14T00:00:00.000Z",
    last_used_at: null,
    idle_expires_at: "2026-08-01T00:00:00.000Z",
    absolute_expires_at: "2026-10-12T00:00:00.000Z",
    revoked_at: null,
    compromised_at: null,
  };
}

async function oldRefreshToken(): Promise<StoredRefreshToken> {
  return {
    id: OLD_REFRESH_ID,
    session_id: "cls_test",
    token_hash: await hashCredential("r".repeat(32)),
    token_family_id: "family-test",
    status: "active",
    parent_token_id: null,
    replaced_by_token_id: null,
    created_at: "2026-07-14T00:00:00.000Z",
    expires_at: "2026-10-12T00:00:00.000Z",
    used_at: null,
    revoked_at: null,
  };
}

function accessToken(): StoredAccessToken {
  return {
    id: "atk_ABCDEFGHIJKLMNOPQRSTUVWX",
    session_id: "cls_test",
    token_hash: "access-hash",
    status: "active",
    created_at: "2026-07-14T00:00:00.000Z",
    expires_at: "2026-07-14T01:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  };
}

function refreshInput(repository: InMemoryAuthDomainRepository) {
  return {
    repository,
    refreshToken: OLD_REFRESH,
    now: NOW,
    makeAccessTokenId: () => NEW_ACCESS_ID,
    makeRefreshTokenId: () => NEW_REFRESH_ID,
    makeAccessToken: () => NEW_ACCESS,
    makeRefreshToken: () => NEW_REFRESH,
  };
}
