import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import { parseBearerTokenString } from "@barestash/shared/bearer-tokens";
import type { AccountId } from "@barestash/shared/ids";
import type {
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
} from "@barestash/shared/personal-access-tokens";
import { describe, expect, it } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  fixedNow,
  makeTestTokenSecret,
  testTokenId,
} from "../../testing/helpers.js";

const TOKEN_ID = testTokenId("scopedpat");
const SECOND_TOKEN_ID = testTokenId("secondpat");
const BOOTSTRAP = "bootstrap-secret-for-local-staging-tests-ok";

describe("scoped Personal Access Token routes", () => {
  it("validates PAT request fields", async () => {
    const app = createTestApiApp({});
    const response = await bootstrapCreate(app, {
      body: { name: 123 },
      idempotencyKey: "invalid-name",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Token name must be a string.",
      },
    });
  });

  it.each([
    "development",
    "staging",
    "production",
  ])("rejects legacy bootstrap issuance in %s", async (environment) => {
    const app = createTestApiApp({});
    const response = await bootstrapCreate(app, {
      environment,
      body: { scopes: AUTHORIZATION_SCOPES },
      idempotencyKey: "disallowed-environment",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_authenticated" },
    });
  });

  it("requires Idempotency-Key for authenticated creation", async () => {
    const repository = new InMemoryAuthDomainRepository();
    const ownerToken = await seedOwnerPat(repository);
    const app = createTestApiApp({
      authDomainRepository: repository,
      now: () => fixedNow,
    });
    const response = await app.request("https://api.example.com/v1/tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["events:read"] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "idempotency_key_required",
        message: "Idempotency-Key is required to create a token.",
      },
    });
  });

  it("does not let an authenticated PAT bypass a disabled account", async () => {
    const repository = new InMemoryAuthDomainRepository();
    const ownerToken = await seedOwnerPat(repository, "disabled");
    const app = createTestApiApp({
      authDomainRepository: repository,
      now: () => fixedNow,
    });

    const response = await app.request("https://api.example.com/v1/tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
        "idempotency-key": "disabled-account",
      },
      body: JSON.stringify({ scopes: ["events:read"] }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_disabled" },
    });
  });

  it("creates, lists, and revokes scoped PATs without returning stored secrets", async () => {
    const repository = new InMemoryAuthDomainRepository();
    const ownerToken = await seedOwnerPat(repository);
    const app = createTestApiApp({
      authDomainRepository: repository,
      now: () => fixedNow,
      generateTokenId: () => SECOND_TOKEN_ID,
      generateTokenSecret: (tokenId) =>
        makeTestTokenSecret(tokenId, "readerpat"),
    });
    const secondResponse = await app.request(
      "https://api.example.com/v1/tokens",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
          "idempotency-key": "read-only-token",
        },
        body: JSON.stringify({
          name: "reader",
          scopes: ["endpoints:read", "events:read"],
          expires_in: 3600,
        }),
      },
    );
    const second =
      (await secondResponse.json()) as PersonalAccessTokenCreateResponse;

    expect(secondResponse.status).toBe(201);
    expect(second.expires_at).toBe("2026-07-05T13:00:00.000Z");
    expect(secondResponse.headers.get("cache-control")).toBe("no-store");

    const listResponse = await app.request(
      "https://api.example.com/v1/tokens",
      {
        headers: { authorization: `Bearer ${ownerToken}` },
      },
    );
    const list = (await listResponse.json()) as PersonalAccessTokenListResponse;

    expect(listResponse.status).toBe(200);
    expect(list.tokens.map(({ id }) => id)).toEqual([
      TOKEN_ID,
      SECOND_TOKEN_ID,
    ]);
    expect(JSON.stringify(list)).not.toContain(ownerToken);
    expect(JSON.stringify(list)).not.toContain(second.token);

    const revokeResponse = await app.request(
      `https://api.example.com/v1/tokens/${SECOND_TOKEN_ID}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${ownerToken}` },
      },
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      token: { id: SECOND_TOKEN_ID, status: "revoked" },
    });

    const activeListResponse = await app.request(
      "https://api.example.com/v1/tokens",
      {
        headers: { authorization: `Bearer ${ownerToken}` },
      },
    );
    const activeList =
      (await activeListResponse.json()) as PersonalAccessTokenListResponse;
    expect(activeList.tokens.map(({ id }) => id)).toEqual([TOKEN_ID]);

    const allResponse = await app.request(
      "https://api.example.com/v1/tokens?all=true",
      {
        headers: { authorization: `Bearer ${ownerToken}` },
      },
    );
    const all = (await allResponse.json()) as PersonalAccessTokenListResponse;
    expect(all.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SECOND_TOKEN_ID, status: "revoked" }),
      ]),
    );
  });
});

async function seedOwnerPat(
  repository: InMemoryAuthDomainRepository,
  status: "active" | "disabled" = "active",
): Promise<string> {
  const rawToken = makeTestTokenSecret(TOKEN_ID, "ownerpat");
  const parsed = parseBearerTokenString(rawToken);
  if (parsed?.type !== "pat") throw new Error("Invalid test PAT.");
  await repository.createAccount({
    id: "acc_owner" as AccountId,
    primary_email: "owner@example.com",
    display_name: null,
    avatar_url: null,
    status,
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
  });
  await repository.createPersonalAccessToken({
    id: TOKEN_ID,
    account_id: "acc_owner",
    name: "owner",
    token_hash: await hashCredential(parsed.secret),
    status: "active",
    scopes: AUTHORIZATION_SCOPES.slice(),
    created_at: fixedNow.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  });
  return rawToken;
}

function bootstrapCreate(
  app: ReturnType<typeof createTestApiApp>,
  options: {
    body?: unknown;
    environment?: string;
    idempotencyKey: string | null;
  },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-barestash-bootstrap-token": BOOTSTRAP,
  };
  if (options.idempotencyKey !== null) {
    headers["idempotency-key"] = options.idempotencyKey;
  }

  return app.request(
    "https://api.example.com/v1/tokens",
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    },
    {
      BARESTASH_BOOTSTRAP_TOKEN: BOOTSTRAP,
      BARESTASH_BOOTSTRAP_TOKEN_ENABLED: "true",
      BARESTASH_ENVIRONMENT: Object.hasOwn(options, "environment")
        ? options.environment
        : "staging",
      BARESTASH_CREDENTIAL_PEPPER: "",
    },
  );
}
