import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import type {
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenReplayResponse,
} from "@barestash/shared/personal-access-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import type {
  StoredAccount,
  StoredPersonalAccessToken,
} from "../../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const CALLER_ID = "tok_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const CREATED_ID = "tok_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
const CALLER_SECRET = "a".repeat(32);
const CREATED_SECRET = "b".repeat(32);

describe("current account and scoped PAT routes", () => {
  let repository: InMemoryAuthDomainRepository;
  let app: ReturnType<typeof createTestApiApp>;

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    const account: StoredAccount = {
      id: "acc_test",
      primary_email: "user@example.com",
      display_name: null,
      avatar_url: null,
      status: "active",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const caller: StoredPersonalAccessToken = {
      id: CALLER_ID,
      account_id: account.id,
      name: "caller",
      token_hash: await hashCredential(CALLER_SECRET, { pepper: "pepper" }),
      status: "active",
      scopes: AUTHORIZATION_SCOPES.slice(),
      created_at: NOW.toISOString(),
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    };
    await repository.createAccount(account);
    await repository.createPersonalAccessToken(caller);
    app = createTestApiApp({
      authDomainRepository: repository,
      now: () => NOW,
      generateTokenId: () => CREATED_ID,
      generatePatIdempotencyId: () => "pid_test",
      generateTokenSecret: () => createdBearer(),
    });
  });

  it("serves GET /v1/account without a resource scope", async () => {
    const response = await app.request(
      "/v1/account",
      {
        headers: { authorization: `Bearer ${callerBearer()}` },
      },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: { id: "acc_test", primary_email: "user@example.com" },
      credential: { type: "personal_access_token", id: CALLER_ID },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("returns a secret only for the original PAT creation response", async () => {
    const request = () =>
      app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${callerBearer()}`,
            "content-type": "application/json",
            "idempotency-key": "logical-create",
          },
          body: JSON.stringify({
            name: "CI",
            scopes: ["events:read"],
            expires_in: 3600,
          }),
        },
        { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
      );

    const first = await request();
    const replay = await request();
    const firstBody = (await first.json()) as PersonalAccessTokenCreateResponse;
    const replayBody =
      (await replay.json()) as PersonalAccessTokenReplayResponse;

    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({ id: CREATED_ID, token: createdBearer() });
    expect(replay.status).toBe(200);
    expect(replayBody).toMatchObject({ id: CREATED_ID });
    expect("token" in replayBody).toBe(false);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(replay.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves expired-PAT outcomes on ordinary resource routes", async () => {
    const expiredRepository = new InMemoryAuthDomainRepository();
    await expiredRepository.createAccount({
      id: "acc_expired",
      primary_email: null,
      display_name: null,
      avatar_url: null,
      status: "active",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    await expiredRepository.createPersonalAccessToken({
      id: CALLER_ID,
      account_id: "acc_expired",
      name: null,
      token_hash: await hashCredential(CALLER_SECRET, { pepper: "pepper" }),
      status: "active",
      scopes: AUTHORIZATION_SCOPES.slice(),
      created_at: NOW.toISOString(),
      expires_at: "2026-07-12T11:59:59.000Z",
      last_used_at: null,
      revoked_at: null,
    });
    const expiredApp = createTestApiApp({
      authDomainRepository: expiredRepository,
      now: () => NOW,
    });

    const response = await expiredApp.request(
      "/v1/endpoints",
      { headers: { authorization: `Bearer ${callerBearer()}` } },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "personal_access_token_expired" },
    });
  });
});

function callerBearer() {
  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: CALLER_ID.slice("tok_".length),
    secret: CALLER_SECRET,
  });
}

function createdBearer() {
  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: CREATED_ID.slice("tok_".length),
    secret: CREATED_SECRET,
  });
}
