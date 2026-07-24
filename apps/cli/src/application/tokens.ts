import {
  type AccountResponse,
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
} from "@barestash/shared/auth";
import type {
  PersonalAccessTokenCreateRequest,
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
  PersonalAccessTokenRevokeResponse,
} from "@barestash/shared/personal-access-tokens";
import { parseTokenDurationSeconds } from "../domain/duration.js";
import type { Confirmer } from "../domain/ports.js";
import { type AuthDeps, authHeaders, resolveAuthToken } from "./auth.js";
import { type CliResult, fromApiCall, localError } from "./result.js";

const READ_ONLY_SCOPES: AuthorizationScope[] = [
  "endpoints:read",
  "events:read",
  "mcp:use",
];

export type TokenDeps = AuthDeps & {
  makeIdempotencyKey?: () => string;
};

export type TokenCreateOptions = {
  name?: string;
  scopes?: AuthorizationScope[];
  preset?: "read-only" | "full-access";
  expiresIn?: string;
  noExpiration?: boolean;
};

type TokenCreateRequestResolution =
  | { kind: "ok"; value: PersonalAccessTokenCreateRequest }
  | { kind: "local-error"; message: string };

/** @public */
export async function createToken(
  deps: TokenDeps,
  options: TokenCreateOptions,
): Promise<CliResult<PersonalAccessTokenCreateResponse>> {
  const resolved = resolveTokenCreateRequest(options);

  if (resolved.kind === "local-error") return resolved;

  const token = await resolveAuthToken(deps);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key":
      deps.makeIdempotencyKey?.() ?? globalThis.crypto.randomUUID(),
  };

  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
    const accountResult = await deps.apiClient.request<AccountResponse>(
      "/v1/account",
      { headers: { authorization: `Bearer ${token}` } },
    );

    if (accountResult.kind === "error") return fromApiCall(accountResult);

    const disallowed = resolved.value.scopes.find(
      (scope) => !accountResult.value.credential.scopes.includes(scope),
    );

    if (disallowed !== undefined) {
      return localError(
        `Requested scope ${disallowed} is broader than the current credential allows.`,
      );
    }
  }

  const result =
    await deps.apiClient.request<PersonalAccessTokenCreateResponse>(
      "/v1/tokens",
      {
        method: "POST",
        headers,
        body: JSON.stringify(resolved.value),
      },
    );

  return fromApiCall(result);
}

/** @public */
export function resolveTokenCreateRequest(
  options: TokenCreateOptions,
): TokenCreateRequestResolution {
  if (options.preset !== undefined && options.scopes?.length) {
    return localError("Use either --preset or --scope, not both.");
  }

  if (options.noExpiration === true && options.expiresIn !== undefined) {
    return localError("Use either --no-expiration or --expires-in, not both.");
  }

  let scopes: AuthorizationScope[];

  if (options.scopes !== undefined && options.scopes.length > 0) {
    scopes = Array.from(new Set(options.scopes));
  } else if (options.preset === "read-only") {
    scopes = READ_ONLY_SCOPES;
  } else {
    scopes = AUTHORIZATION_SCOPES.slice();
  }

  let expiresIn: number | null | undefined;

  try {
    expiresIn =
      options.noExpiration === true
        ? null
        : options.expiresIn === undefined
          ? undefined
          : parseTokenDurationSeconds(options.expiresIn);
  } catch (error) {
    return localError(
      error instanceof Error ? error.message : "Invalid token expiration.",
    );
  }

  return {
    kind: "ok",
    value: {
      ...(options.name === undefined ? {} : { name: options.name }),
      scopes,
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    },
  };
}

/** @public */
export async function listTokens(
  deps: TokenDeps,
  all: boolean,
): Promise<CliResult<PersonalAccessTokenListResponse>> {
  const suffix = all ? "?all=true" : "";
  const result = await deps.apiClient.request<PersonalAccessTokenListResponse>(
    `/v1/tokens${suffix}`,
    { headers: await authHeaders(deps) },
  );

  return fromApiCall(result);
}

export type RevokeTokenDeps = TokenDeps & { confirmer: Confirmer };

/** @public */
export async function revokeToken(
  deps: RevokeTokenDeps,
  tokenId: string,
  yes: boolean,
): Promise<CliResult<PersonalAccessTokenRevokeResponse>> {
  if (!yes) {
    const confirmed = await deps.confirmer.confirm(`Revoke token ${tokenId}?`);
    if (!confirmed) return localError("Token revocation cancelled.");
  }

  const result =
    await deps.apiClient.request<PersonalAccessTokenRevokeResponse>(
      `/v1/tokens/${tokenId}`,
      { method: "DELETE", headers: await authHeaders(deps) },
    );
  return fromApiCall(result);
}
