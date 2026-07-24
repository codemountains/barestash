import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type AuthPrincipal,
} from "@barestash/shared/auth";
import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StoredAccount,
  StoredPersonalAccessToken,
} from "../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import { hashCredential } from "./credential-hash.js";
import { err, ok } from "./result.js";
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from "./tokens.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const ACCOUNT_ID = "acc_test" as const;
const CALLER_ID = "tok_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const CREATED_ID = "tok_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
const CALLER_SECRET = "a".repeat(32);
const CREATED_SECRET = "b".repeat(32);

describe("Personal Access Token use cases", () => {
  let repository: InMemoryAuthDomainRepository;
  let callerScopes: AuthorizationScope[];

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    callerScopes = AUTHORIZATION_SCOPES.slice();
    await repository.createAccount(account());
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates once and replays only metadata for an identical idempotency key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createCaller(AUTHORIZATION_SCOPES.slice());
    const deps = createDeps({
      idempotencyKey: "logical-create",
      body: {
        name: "CI",
        scopes: ["events:read"],
        expires_in: 3600,
      },
    });

    const first = await createPersonalAccessToken(deps);
    const replay = await createPersonalAccessToken(deps);

    expect(first).toMatchObject({
      kind: "ok",
      value: {
        replayed: false,
        token: {
          id: CREATED_ID,
          token: expect.stringMatching(/^bst_pat_/),
          scopes: ["events:read"],
          expires_at: "2026-07-12T13:00:00.000Z",
        },
      },
    });
    expect(replay).toMatchObject({
      kind: "ok",
      value: {
        replayed: true,
        token: {
          id: CREATED_ID,
          scopes: ["events:read"],
        },
      },
    });
    expect(replay.kind === "ok" && "token" in replay.value.token).toBe(false);
    await expect(
      repository.listPersonalAccessTokens(ACCOUNT_ID, {
        includeInactive: true,
        now: NOW,
      }),
    ).resolves.toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.personal_access_token.created",
        account_id: ACCOUNT_ID,
        token_id: CREATED_ID,
      }),
    );
    expect(log.mock.calls.join("\n")).not.toContain(createdBearer());
  });

  it("rejects idempotency-key reuse with a different request", async () => {
    await createCaller(AUTHORIZATION_SCOPES.slice());
    await createPersonalAccessToken(
      createDeps({
        idempotencyKey: "logical-create",
        body: { scopes: ["events:read"] },
      }),
    );

    const result = await createPersonalAccessToken(
      createDeps({
        idempotencyKey: "logical-create",
        body: { scopes: ["tokens:read"] },
      }),
    );

    expect(result).toMatchObject({
      kind: "error",
      code: "idempotency_key_conflict",
    });
  });

  it("allows an idempotency key to be reused after the 24-hour window", async () => {
    await createCaller(AUTHORIZATION_SCOPES.slice());
    await createPersonalAccessToken(
      createDeps({
        idempotencyKey: "expiring-key",
        body: { scopes: ["events:read"] },
      }),
    );
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);

    const result = await createPersonalAccessToken({
      ...createDeps({
        idempotencyKey: "expiring-key",
        body: { scopes: ["tokens:read"] },
      }),
      now: later,
      makeTokenId: () => "tok_1234567890ABCDEFGHIJKLMN",
      makeTokenSecret: (tokenId) =>
        formatBearerTokenString({
          type: "pat",
          tokenIdSuffix: tokenId.slice("tok_".length),
          secret: "c".repeat(32),
        }),
      makePatIdempotencyId: () => "pid_later",
    });

    expect(result).toMatchObject({
      kind: "ok",
      value: { replayed: false, token: { scopes: ["tokens:read"] } },
    });
  });

  it("rejects requested scopes outside the caller grants without minting", async () => {
    await createCaller(["tokens:write"]);

    const result = await createPersonalAccessToken(
      createDeps({
        idempotencyKey: "scope-escalation",
        body: { scopes: ["tokens:write", "events:read"] },
      }),
    );

    expect(result).toMatchObject({
      kind: "error",
      code: "insufficient_scope",
      message: expect.stringContaining("events:read"),
    });
    await expect(
      repository.findPersonalAccessTokenById(CREATED_ID),
    ).resolves.toBeNull();
  });

  it("lists active PAT metadata without secrets and includes inactive with all", async () => {
    await createCaller(["tokens:read"]);
    await repository.createPersonalAccessToken(
      await storedPat({
        id: CREATED_ID,
        token_hash: await hashCredential(CREATED_SECRET, { pepper: "pepper" }),
        status: "revoked",
        revoked_at: NOW.toISOString(),
      }),
    );

    const active = await listPersonalAccessTokens({
      repository,
      authorizationHeader: `Bearer ${callerBearer()}`,
      credentialPepper: "pepper",
      now: NOW,
      includeInactive: false,
    });
    const all = await listPersonalAccessTokens({
      repository,
      authorizationHeader: `Bearer ${callerBearer()}`,
      credentialPepper: "pepper",
      now: NOW,
      includeInactive: true,
    });

    expect(active).toMatchObject({
      kind: "ok",
      value: { tokens: [{ id: CALLER_ID }] },
    });
    expect(all).toMatchObject({ kind: "ok", value: { tokens: [{}, {}] } });
    expect(JSON.stringify(all)).not.toContain(CALLER_SECRET);
    expect(JSON.stringify(all)).not.toContain(CREATED_SECRET);
  });

  it("allows scope-free self-revocation and makes a retry idempotent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createCaller(["events:read"]);
    const deps = {
      repository,
      authorizationHeader: `Bearer ${callerBearer()}`,
      credentialPepper: "pepper",
      now: NOW,
      tokenId: CALLER_ID,
    };

    const first = await revokePersonalAccessToken({
      ...deps,
      authentication: ok(callerPrincipal()),
    });
    const second = await revokePersonalAccessToken({
      ...deps,
      authentication: {
        ...err("token_revoked", "The token has been revoked.", 401),
        verifiedRevokedPersonalAccessToken: {
          id: CALLER_ID,
          name: "caller",
          status: "revoked",
          scopes: callerScopes,
          created_at: NOW.toISOString(),
          expires_at: null,
          last_used_at: null,
          revoked_at: NOW.toISOString(),
        },
      },
    });

    expect(first).toMatchObject({
      kind: "ok",
      value: { token: { id: CALLER_ID, status: "revoked" } },
    });
    expect(second).toMatchObject({
      kind: "ok",
      value: { token: { id: CALLER_ID, status: "revoked" } },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.personal_access_token.revoked",
        account_id: ACCOUNT_ID,
        token_id: CALLER_ID,
      }),
    );
  });

  async function createCaller(scopes: AuthorizationScope[]) {
    callerScopes = scopes;
    await repository.createPersonalAccessToken(await storedPat({ scopes }));
  }

  function callerPrincipal(): AuthPrincipal {
    return {
      accountId: ACCOUNT_ID,
      credential: {
        type: "personal_access_token",
        id: CALLER_ID,
        scopes: callerScopes,
        expiresAt: null,
      },
    };
  }

  function createDeps(overrides: {
    idempotencyKey: string | null;
    body: {
      name?: string;
      scopes: AuthorizationScope[];
      expires_in?: number | null;
    };
  }) {
    return {
      repository,
      authentication: ok(callerPrincipal()),
      credentialPepper: "pepper",
      now: NOW,
      makeTokenId: () => CREATED_ID,
      makeTokenSecret: () => createdBearer(),
      makePatIdempotencyId: () => "pid_test" as const,
      ...overrides,
    };
  }
});

function account(): StoredAccount {
  return {
    id: ACCOUNT_ID,
    primary_email: "user@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

async function storedPat(
  overrides: Partial<StoredPersonalAccessToken> = {},
): Promise<StoredPersonalAccessToken> {
  return {
    id: CALLER_ID,
    account_id: ACCOUNT_ID,
    name: "caller",
    token_hash: await hashCredential(CALLER_SECRET, { pepper: "pepper" }),
    status: "active",
    scopes: AUTHORIZATION_SCOPES.slice(),
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function callerBearer(): string {
  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: CALLER_ID.slice("tok_".length),
    secret: CALLER_SECRET,
  });
}

function createdBearer(): string {
  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: CREATED_ID.slice("tok_".length),
    secret: CREATED_SECRET,
  });
}
