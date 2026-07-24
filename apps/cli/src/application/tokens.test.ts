import type { AccountResponse } from "@barestash/shared/auth";
import type { RestErrorResponse } from "@barestash/shared/errors";
import type {
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
  PersonalAccessTokenRevokeResponse,
} from "@barestash/shared/personal-access-tokens";
import { describe, expect, it } from "vitest";

import type { ConfigStore } from "../domain/ports.js";
import type { FetchApiClient } from "../infrastructure/api/client.js";
import {
  createToken,
  listTokens,
  revokeToken,
  type TokenDeps,
} from "./tokens.js";

const configStore = (token?: string): ConfigStore => ({
  read: async () => ({ token }),
  write: async () => {},
  delete: async () => {},
});

const account: AccountResponse = {
  account: { id: "acc_test", primary_email: "user@example.com" },
  credential: {
    type: "personal_access_token",
    id: "tok_current",
    scopes: ["tokens:write", "events:read"],
    expires_at: null,
  },
};

describe("createToken", () => {
  it("validates scopes against /v1/account and sends resolved PAT options", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const response: PersonalAccessTokenCreateResponse = {
      id: "tok_created",
      name: "CI",
      token: "bst_pat_created",
      status: "active",
      scopes: ["events:read"],
      created_at: "2026-07-05T12:00:00.000Z",
      expires_at: "2026-10-03T12:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    };
    const deps: TokenDeps = {
      env: { BARESTASH_TOKEN: "caller" },
      configStore: configStore(),
      makeIdempotencyKey: () => "logical-create",
      apiClient: {
        request: async <T>(path: string, init?: RequestInit) => {
          requests.push({ path, init });
          return {
            kind: "ok",
            value: (path === "/v1/account" ? account : response) as T,
          };
        },
      } as unknown as FetchApiClient,
    };

    const result = await createToken(deps, {
      name: "CI",
      scopes: ["events:read"],
      expiresIn: "90d",
    });

    expect(result).toEqual({ kind: "ok", value: response });
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/account",
      "/v1/tokens",
    ]);
    expect(requests[1].init?.headers).toEqual({
      authorization: "Bearer caller",
      "content-type": "application/json",
      "idempotency-key": "logical-create",
    });
    expect(JSON.parse(requests[1].init?.body as string)).toEqual({
      name: "CI",
      scopes: ["events:read"],
      expires_in: 7_776_000,
    });
  });

  it("does not submit scopes broader than the current principal grants", async () => {
    const paths: string[] = [];
    const result = await createToken(
      {
        env: { BARESTASH_TOKEN: "caller" },
        configStore: configStore(),
        makeIdempotencyKey: () => "unused",
        apiClient: {
          request: async <T>(path: string) => {
            paths.push(path);
            return { kind: "ok", value: account as T };
          },
        } as unknown as FetchApiClient,
      },
      { scopes: ["endpoints:write"] },
    );

    expect(paths).toEqual(["/v1/account"]);
    expect(result).toEqual({
      kind: "local-error",
      message:
        "Requested scope endpoints:write is broader than the current credential allows.",
    });
  });

  it("never forwards the removed bootstrap credential", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    await createToken(
      {
        env: { BARESTASH_BOOTSTRAP_TOKEN: "legacy-bootstrap" },
        configStore: configStore(),
        makeIdempotencyKey: () => "bootstrap-create",
        apiClient: {
          request: async <T>(path: string, init?: RequestInit) => {
            requests.push({ path, init });
            return { kind: "ok", value: {} as T };
          },
        } as unknown as FetchApiClient,
      },
      { preset: "read-only", noExpiration: true },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].init?.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": "bootstrap-create",
    });
    expect(JSON.parse(requests[0].init?.body as string)).toEqual({
      scopes: ["endpoints:read", "events:read", "mcp:use"],
      expires_in: null,
    });
  });
});

describe("listTokens", () => {
  it("adds the all query parameter and forwards API errors", async () => {
    const error: RestErrorResponse = {
      error: { code: "not_authenticated", message: "Missing token." },
    };
    const paths: string[] = [];
    const result = await listTokens(
      {
        env: { BARESTASH_TOKEN: "token" },
        configStore: configStore(),
        makeIdempotencyKey: () => "unused",
        apiClient: {
          request: async (path: string) => {
            paths.push(path);
            return { kind: "error", error };
          },
        } as unknown as FetchApiClient,
      },
      true,
    );
    expect(paths).toEqual(["/v1/tokens?all=true"]);
    expect(result).toEqual({ kind: "api-error", error });
  });
});

describe("revokeToken", () => {
  it("deletes immediately when confirmation is bypassed", async () => {
    const response: PersonalAccessTokenRevokeResponse = {
      token: {
        id: "tok_delete",
        name: null,
        status: "revoked",
        scopes: [],
        created_at: "2026-07-05T12:00:00.000Z",
        expires_at: null,
        last_used_at: null,
        revoked_at: "2026-07-06T12:00:00.000Z",
      },
    };
    const result = await revokeToken(
      {
        env: { BARESTASH_TOKEN: "token" },
        configStore: configStore(),
        makeIdempotencyKey: () => "unused",
        apiClient: {
          request: async <T>() => ({ kind: "ok", value: response as T }),
        } as unknown as FetchApiClient,
        confirmer: { confirm: async () => false },
      },
      "tok_delete",
      true,
    );
    expect(result).toEqual({ kind: "ok", value: response });
  });
});

const _listContract: PersonalAccessTokenListResponse = { tokens: [] };
void _listContract;
