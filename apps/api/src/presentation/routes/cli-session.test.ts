import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import type {
  StoredAccessToken,
  StoredAccount,
  StoredCliSession,
  StoredRefreshToken,
} from "../../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const ACCESS_ID = "atk_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const REFRESH_ID = "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const ACCESS_SECRET = "a".repeat(32);
const REFRESH_SECRET = "r".repeat(32);

describe("CLI session routes", () => {
  let repository: InMemoryAuthDomainRepository;
  let app: ReturnType<typeof createTestApiApp>;

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount(account());
    await repository.createCliSession(session());
    await repository.createAccessToken(await accessToken());
    await repository.createRefreshToken(await refreshToken());
    app = createTestApiApp({
      authDomainRepository: repository,
      now: () => NOW,
      generateAccessTokenId: () => "atk_BCDEFGHIJKLMNOPQRSTUVWXY",
      generateRefreshTokenId: () => "rtk_BCDEFGHIJKLMNOPQRSTUVWXY",
      generateAccessToken: () => bearer("access", "B", "n"),
      generateRefreshToken: () => bearer("refresh", "B", "m"),
    });
  });

  it("exchanges a refresh token without bearer authentication", async () => {
    const response = await app.request(
      "/v1/auth/token/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: bearer("refresh", "A", "r"),
        }),
      },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 7_776_000,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("revokes the bearer token's current CLI session", async () => {
    const response = await app.request(
      "/v1/auth/sessions/current/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${bearer("access", "A", "a")}` },
      },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: { id: "cls_test", status: "revoked" },
    });
    expect(await repository.findCliSessionById("cls_test")).toMatchObject({
      status: "revoked",
    });
  });

  it("rejects a PAT on the current CLI session revoke endpoint", async () => {
    await repository.createPersonalAccessToken({
      id: "tok_ABCDEFGHIJKLMNOPQRSTUVWX",
      account_id: "acc_test",
      name: null,
      token_hash: await hashCredential("p".repeat(32), { pepper: "pepper" }),
      status: "active",
      scopes: ["events:read"],
      created_at: NOW.toISOString(),
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    });
    const response = await app.request(
      "/v1/auth/sessions/current/revoke",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${formatBearerTokenString({
            type: "pat",
            tokenIdSuffix: "ABCDEFGHIJKLMNOPQRSTUVWX",
            secret: "p".repeat(32),
          })}`,
        },
      },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(401);
  });
});

function bearer(type: "access" | "refresh", id: "A" | "B", secret: string) {
  return formatBearerTokenString({
    type,
    tokenIdSuffix:
      id === "A" ? "ABCDEFGHIJKLMNOPQRSTUVWX" : "BCDEFGHIJKLMNOPQRSTUVWXY",
    secret: secret.repeat(32),
  });
}

function account(): StoredAccount {
  return {
    id: "acc_test",
    primary_email: "user@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function session(): StoredCliSession {
  return {
    id: "cls_test",
    account_id: "acc_test",
    device_name: null,
    client_version: "0.0.0",
    status: "active",
    scopes: ["events:read"],
    created_at: NOW.toISOString(),
    last_used_at: null,
    idle_expires_at: "2026-08-13T00:00:00.000Z",
    absolute_expires_at: "2026-10-12T00:00:00.000Z",
    revoked_at: null,
    compromised_at: null,
  };
}

async function accessToken(): Promise<StoredAccessToken> {
  return {
    id: ACCESS_ID,
    session_id: "cls_test",
    token_hash: await hashCredential(ACCESS_SECRET, { pepper: "pepper" }),
    status: "active",
    created_at: NOW.toISOString(),
    expires_at: "2026-07-14T01:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  };
}

async function refreshToken(): Promise<StoredRefreshToken> {
  return {
    id: REFRESH_ID,
    session_id: "cls_test",
    token_hash: await hashCredential(REFRESH_SECRET, { pepper: "pepper" }),
    token_family_id: "family-test",
    status: "active",
    parent_token_id: null,
    replaced_by_token_id: null,
    created_at: NOW.toISOString(),
    expires_at: "2026-10-12T00:00:00.000Z",
    used_at: null,
    revoked_at: null,
  };
}
