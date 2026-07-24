import {
  AUTHORIZATION_SCOPES,
  type AuthPrincipal,
} from "@barestash/shared/auth";
import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  StoredAccessToken,
  StoredAccount,
  StoredCliSession,
  StoredPersonalAccessToken,
} from "../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import {
  authenticateBearerPrincipal,
  authenticateRequest,
  requireEndpointOwner,
  requireRequestedScopesSubset,
  requireScope,
} from "./auth.js";
import { hashCredential } from "./credential-hash.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const PAT_ID = "tok_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const ACCESS_TOKEN_ID = "atk_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
const PAT_SECRET = "a".repeat(32);
const ACCESS_SECRET = "b".repeat(32);

const account: StoredAccount = {
  id: "acc_test",
  primary_email: "user@example.com",
  display_name: "Test User",
  avatar_url: null,
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const session: StoredCliSession = {
  id: "cls_test",
  account_id: account.id,
  device_name: null,
  client_version: "0.1.0",
  status: "active",
  scopes: ["events:read", "tokens:read"],
  created_at: NOW.toISOString(),
  last_used_at: null,
  idle_expires_at: "2026-08-12T12:00:00.000Z",
  absolute_expires_at: "2026-10-12T12:00:00.000Z",
  revoked_at: null,
  compromised_at: null,
};

describe("authenticateBearerPrincipal", () => {
  let repository: InMemoryAuthDomainRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthDomainRepository();
    await repository.createAccount(account);
  });

  it("authenticates a scoped PAT and updates last-used metadata", async () => {
    await repository.createPersonalAccessToken(
      await personalAccessToken({ scopes: ["events:read"] }),
    );

    const result = await authenticateBearerPrincipal(
      `Bearer ${patBearer()}`,
      repository,
      NOW,
      { pepper: "pepper" },
    );

    expect(result).toEqual({
      kind: "ok",
      value: {
        accountId: account.id,
        credential: {
          type: "personal_access_token",
          id: PAT_ID,
          scopes: ["events:read"],
          expiresAt: "2026-10-10T12:00:00.000Z",
        },
      } satisfies AuthPrincipal,
    });
    await expect(
      repository.findPersonalAccessTokenById(PAT_ID),
    ).resolves.toMatchObject({
      last_used_at: NOW.toISOString(),
    });
  });

  it("authenticates a CLI access token through its active session", async () => {
    await repository.createCliSession(session);
    await repository.createAccessToken(await accessToken());

    const result = await authenticateBearerPrincipal(
      `Bearer ${accessBearer()}`,
      repository,
      NOW,
      { pepper: "pepper" },
    );

    expect(result).toEqual({
      kind: "ok",
      value: {
        accountId: account.id,
        credential: {
          type: "cli_access_token",
          id: ACCESS_TOKEN_ID,
          sessionId: session.id,
          scopes: session.scopes,
          expiresAt: "2026-07-12T13:00:00.000Z",
        },
      } satisfies AuthPrincipal,
    });
    await expect(
      repository.findAccessTokenById(ACCESS_TOKEN_ID),
    ).resolves.toMatchObject({ last_used_at: NOW.toISOString() });
    await expect(
      repository.findCliSessionById(session.id),
    ).resolves.toMatchObject({ last_used_at: NOW.toISOString() });
  });

  it("authenticates narrow credentials before an operation-specific scope check", async () => {
    await repository.createPersonalAccessToken(
      await personalAccessToken({ scopes: ["tokens:read"] }),
    );

    const result = await authenticateRequest(
      `Bearer ${patBearer()}`,
      repository,
      NOW,
      { pepper: "pepper" },
    );

    expect(result).toEqual({
      kind: "ok",
      value: { accountId: account.id, tokenId: PAT_ID },
    });
  });

  it("shares scope, requested-scope subset, and endpoint-owner decisions", () => {
    const principal = {
      accountId: account.id,
      credential: {
        type: "personal_access_token" as const,
        id: PAT_ID,
        scopes: ["events:read"] as const,
        expiresAt: "2026-10-10T12:00:00.000Z",
      },
    } satisfies AuthPrincipal;
    const endpoint = {
      id: "ep_authz",
      account_id: account.id,
    };

    expect(requireScope(principal, "events:read")).toEqual({
      kind: "ok",
      value: principal,
    });
    expect(requireScope(principal, "endpoints:read")).toMatchObject({
      kind: "error",
      code: "insufficient_scope",
      message: expect.stringContaining("endpoints:read"),
    });
    expect(requireRequestedScopesSubset(principal, ["events:read"])).toEqual({
      kind: "ok",
      value: principal,
    });
    expect(
      requireRequestedScopesSubset(principal, ["tokens:read"]),
    ).toMatchObject({
      kind: "error",
      code: "insufficient_scope",
      message: expect.stringContaining("tokens:read"),
    });
    expect(requireEndpointOwner(principal, endpoint)).toEqual({
      kind: "ok",
      value: principal,
    });
    expect(
      requireEndpointOwner(principal, { ...endpoint, account_id: "acc_other" }),
    ).toMatchObject({ kind: "error", code: "not_authorized" });
  });

  it("preserves legacy-equivalent access for a full-scope principal", async () => {
    await repository.createPersonalAccessToken(
      await personalAccessToken({ scopes: AUTHORIZATION_SCOPES.slice() }),
    );

    const result = await authenticateRequest(
      `Bearer ${patBearer()}`,
      repository,
      NOW,
      { pepper: "pepper" },
    );

    expect(result).toMatchObject({
      kind: "ok",
      value: { accountId: account.id },
    });
  });

  it.each([
    ["malformed", "Bearer not-a-barestash-token", "invalid_token"],
    ["revoked", `Bearer ${patBearer()}`, "token_revoked"],
    ["expired", `Bearer ${patBearer()}`, "personal_access_token_expired"],
    ["disabled account", `Bearer ${patBearer()}`, "account_disabled"],
  ])("returns a distinct outcome for %s credentials", async (kind, header, code) => {
    if (kind !== "malformed") {
      if (kind === "disabled account") {
        repository = new InMemoryAuthDomainRepository();
        await repository.createAccount({ ...account, status: "disabled" });
      }

      await repository.createPersonalAccessToken(
        await personalAccessToken({
          status: kind === "revoked" ? "revoked" : "active",
          expires_at:
            kind === "expired"
              ? "2026-07-12T11:59:59.000Z"
              : "2026-10-10T12:00:00.000Z",
        }),
      );
    }

    const result = await authenticateBearerPrincipal(header, repository, NOW, {
      pepper: "pepper",
    });

    expect(result).toMatchObject({ kind: "error", code });
  });
});

async function personalAccessToken(
  overrides: Partial<StoredPersonalAccessToken> = {},
): Promise<StoredPersonalAccessToken> {
  return {
    id: PAT_ID,
    account_id: account.id,
    name: "CI",
    token_hash: await hashCredential(PAT_SECRET, { pepper: "pepper" }),
    status: "active",
    scopes: ["events:read"],
    created_at: NOW.toISOString(),
    expires_at: "2026-10-10T12:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function accessToken(): Promise<StoredAccessToken> {
  return {
    id: ACCESS_TOKEN_ID,
    session_id: session.id,
    token_hash: await hashCredential(ACCESS_SECRET, { pepper: "pepper" }),
    status: "active",
    created_at: NOW.toISOString(),
    expires_at: "2026-07-12T13:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  };
}

function patBearer(): string {
  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: PAT_ID.slice("tok_".length),
    secret: PAT_SECRET,
  });
}

function accessBearer(): string {
  return formatBearerTokenString({
    type: "access",
    tokenIdSuffix: ACCESS_TOKEN_ID.slice("atk_".length),
    secret: ACCESS_SECRET,
  });
}
