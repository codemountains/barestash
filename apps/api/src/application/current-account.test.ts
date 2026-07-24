import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import { describe, expect, it } from "vitest";

import type {
  StoredAccount,
  StoredPersonalAccessToken,
} from "../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import { hashCredential } from "./credential-hash.js";
import { getCurrentAccount } from "./current-account.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const TOKEN_ID = "tok_ABCDEFGHIJKLMNOPQRSTUVWX" as const;
const SECRET = "a".repeat(32);

describe("getCurrentAccount", () => {
  it("returns the current account and PAT metadata without requiring a scope", async () => {
    const repository = new InMemoryAuthDomainRepository();
    const account: StoredAccount = {
      id: "acc_test",
      primary_email: "user@example.com",
      display_name: "User",
      avatar_url: null,
      status: "active",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const token: StoredPersonalAccessToken = {
      id: TOKEN_ID,
      account_id: account.id,
      name: null,
      token_hash: await hashCredential(SECRET, { pepper: "pepper" }),
      status: "active",
      scopes: [],
      created_at: NOW.toISOString(),
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    };
    await repository.createAccount(account);
    await repository.createPersonalAccessToken(token);

    const result = await getCurrentAccount({
      repository,
      authorizationHeader: `Bearer ${formatBearerTokenString({
        type: "pat",
        tokenIdSuffix: TOKEN_ID.slice("tok_".length),
        secret: SECRET,
      })}`,
      credentialPepper: "pepper",
      now: NOW,
    });

    expect(result).toEqual({
      kind: "ok",
      value: {
        account: { id: account.id, primary_email: account.primary_email },
        credential: {
          type: "personal_access_token",
          id: token.id,
          scopes: [],
          expires_at: null,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("status");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("returns CLI access token session metadata through the same endpoint", async () => {
    const repository = new InMemoryAuthDomainRepository();
    const account: StoredAccount = {
      id: "acc_cli",
      primary_email: "cli@example.com",
      display_name: null,
      avatar_url: null,
      status: "active",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const sessionId = "cls_test" as const;
    const accessTokenId = "atk_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
    const secret = "b".repeat(32);
    await repository.createAccount(account);
    await repository.createCliSession({
      id: sessionId,
      account_id: account.id,
      device_name: null,
      client_version: "0.1.0",
      status: "active",
      scopes: ["events:read"],
      created_at: NOW.toISOString(),
      last_used_at: null,
      idle_expires_at: "2026-08-12T12:00:00.000Z",
      absolute_expires_at: "2026-10-12T12:00:00.000Z",
      revoked_at: null,
      compromised_at: null,
    });
    await repository.createAccessToken({
      id: accessTokenId,
      session_id: sessionId,
      token_hash: await hashCredential(secret, { pepper: "pepper" }),
      status: "active",
      created_at: NOW.toISOString(),
      expires_at: "2026-07-12T13:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    });

    const result = await getCurrentAccount({
      repository,
      authorizationHeader: `Bearer ${formatBearerTokenString({
        type: "access",
        tokenIdSuffix: accessTokenId.slice("atk_".length),
        secret,
      })}`,
      credentialPepper: "pepper",
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: "ok",
      value: {
        account: { id: account.id },
        credential: {
          type: "cli_access_token",
          id: accessTokenId,
          session_id: sessionId,
          scopes: ["events:read"],
        },
      },
    });
  });
});
