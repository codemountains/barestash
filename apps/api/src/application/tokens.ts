import type { AuthPrincipal } from "@barestash/shared/auth";
import { parseBearerTokenString } from "@barestash/shared/bearer-tokens";
import type {
  PersonalAccessTokenCreateRequest,
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
  PersonalAccessTokenMetadata,
  PersonalAccessTokenReplayResponse,
} from "@barestash/shared/personal-access-tokens";

import type {
  AuthDomainRepository,
  StoredPatIdempotencyRecord,
  StoredPersonalAccessToken,
} from "../domain/auth-domain.js";
import {
  authenticateBearerPrincipal,
  type CredentialPepperDeps,
  type PrincipalAuthenticationResult,
  requireRequestedScopesSubset,
  requireScope,
} from "./auth.js";
import { logAuthAudit } from "./auth-audit.js";
import { hashCredential } from "./credential-hash.js";
import { err, ok, type UseCaseResult } from "./result.js";

const DEFAULT_PAT_EXPIRATION_SECONDS = 90 * 24 * 60 * 60;
const IDEMPOTENCY_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;

type PersonalAccessTokenDeps = CredentialPepperDeps & {
  repository: AuthDomainRepository;
  now: Date;
  authorizationHeader: string | null;
};

export type CreatePersonalAccessTokenDeps = CredentialPepperDeps & {
  repository: AuthDomainRepository;
  now: Date;
  authentication: UseCaseResult<AuthPrincipal>;
  idempotencyKey: string | null;
  body: PersonalAccessTokenCreateRequest;
  makeTokenId: () => import("@barestash/shared/ids").TokenId;
  makeTokenSecret: (tokenId: import("@barestash/shared/ids").TokenId) => string;
  makePatIdempotencyId: () => import("@barestash/shared/ids").PatIdempotencyId;
};

/** @public */
export async function createPersonalAccessToken(
  deps: CreatePersonalAccessTokenDeps,
): Promise<
  UseCaseResult<{
    replayed: boolean;
    token:
      | PersonalAccessTokenCreateResponse
      | PersonalAccessTokenReplayResponse;
  }>
> {
  if (deps.authentication.kind === "error") return deps.authentication;

  const scopeError = requireScope(deps.authentication.value, "tokens:write");
  if (scopeError.kind === "error") return scopeError;
  const principal: AuthPrincipal = scopeError.value;
  const accountId = principal.accountId;

  if (deps.idempotencyKey === null || deps.idempotencyKey.trim() === "") {
    return err(
      "idempotency_key_required",
      "Idempotency-Key is required to create a token.",
      400,
    );
  }

  const subset = requireRequestedScopesSubset(principal, deps.body.scopes);

  if (subset.kind === "error") return subset;

  const requestHash = await hashPatRequest(deps.body);
  const existing = await deps.repository.findPatIdempotencyRecord(
    accountId,
    deps.idempotencyKey,
    deps.now,
  );

  if (existing !== null) {
    return replayPersonalAccessToken(
      deps.repository,
      existing,
      requestHash,
      deps.now,
    );
  }

  const tokenId = deps.makeTokenId();
  const rawToken = deps.makeTokenSecret(tokenId);
  const parsed = parseBearerTokenString(rawToken);

  if (parsed === null || parsed.type !== "pat") {
    return err("internal_error", "Failed to create token metadata.", 500);
  }

  const nowIso = deps.now.toISOString();
  const expiresIn =
    deps.body.expires_in === undefined
      ? DEFAULT_PAT_EXPIRATION_SECONDS
      : deps.body.expires_in;
  const token: StoredPersonalAccessToken = {
    id: tokenId,
    account_id: accountId,
    name: normalizeTokenName(deps.body.name),
    token_hash: await hashCredential(parsed.secret, {
      pepper: deps.credentialPepper ?? "",
    }),
    status: "active",
    scopes: deps.body.scopes,
    created_at: nowIso,
    expires_at:
      expiresIn === null
        ? null
        : new Date(deps.now.getTime() + expiresIn * 1000).toISOString(),
    last_used_at: null,
    revoked_at: null,
  };
  const idempotency: StoredPatIdempotencyRecord = {
    id: deps.makePatIdempotencyId(),
    account_id: accountId,
    idempotency_key: deps.idempotencyKey,
    request_hash: requestHash,
    token_id: token.id,
    created_at: nowIso,
    expires_at: new Date(
      deps.now.getTime() + IDEMPOTENCY_RETENTION_MILLISECONDS,
    ).toISOString(),
  };

  try {
    const outcome = await deps.repository.createPersonalAccessTokenIdempotently(
      token,
      idempotency,
    );

    if (outcome === "existing") {
      const racedRecord = await deps.repository.findPatIdempotencyRecord(
        accountId,
        deps.idempotencyKey,
        deps.now,
      );

      if (racedRecord === null) {
        return err("d1_write_failed", "Failed to create token metadata.", 500);
      }

      return replayPersonalAccessToken(
        deps.repository,
        racedRecord,
        requestHash,
        deps.now,
      );
    }
  } catch {
    return err("d1_write_failed", "Failed to create token metadata.", 500);
  }

  logAuthAudit({
    event: "barestash.auth.personal_access_token.created",
    account_id: accountId,
    token_id: token.id,
  });

  return ok({
    replayed: false,
    token: { ...personalAccessTokenMetadata(token, deps.now), token: rawToken },
  });
}

export type ListPersonalAccessTokensDeps = PersonalAccessTokenDeps & {
  includeInactive: boolean;
};

/** @public */
export async function listPersonalAccessTokens(
  deps: ListPersonalAccessTokensDeps,
): Promise<UseCaseResult<PersonalAccessTokenListResponse>> {
  const principal = await authenticateBearerPrincipal(
    deps.authorizationHeader,
    deps.repository,
    deps.now,
    { pepper: deps.credentialPepper ?? "" },
  );

  if (principal.kind === "error") return principal;

  const scopeError = requireScope(principal.value, "tokens:read");
  if (scopeError.kind === "error") return scopeError;

  const tokens = await deps.repository.listPersonalAccessTokens(
    principal.value.accountId,
    { includeInactive: deps.includeInactive, now: deps.now },
  );
  return ok({
    tokens: tokens.map((token) => personalAccessTokenMetadata(token, deps.now)),
  });
}

export type RevokePersonalAccessTokenDeps = {
  repository: AuthDomainRepository;
  now: Date;
  authentication: PrincipalAuthenticationResult;
  tokenId: import("@barestash/shared/ids").TokenId;
};

/** @public */
export async function revokePersonalAccessToken(
  deps: RevokePersonalAccessTokenDeps,
): Promise<UseCaseResult<{ token: PersonalAccessTokenMetadata }>> {
  if (deps.authentication.kind === "error") {
    const revokedSelf = deps.authentication.verifiedRevokedPersonalAccessToken;

    if (
      deps.authentication.code === "token_revoked" &&
      revokedSelf?.id === deps.tokenId
    ) {
      return ok({ token: revokedSelf });
    }

    return deps.authentication;
  }

  const isSelf =
    deps.authentication.value.credential.type === "personal_access_token" &&
    deps.authentication.value.credential.id === deps.tokenId;
  const scopeError = requireScope(deps.authentication.value, "tokens:write");

  if (!isSelf && scopeError.kind === "error") return scopeError;

  const token = await deps.repository.revokePersonalAccessToken(
    deps.tokenId,
    deps.authentication.value.accountId,
    deps.now.toISOString(),
  );

  if (token === null) {
    return err("not_authorized", `Token not found: ${deps.tokenId}`, 404);
  }

  if (token.revoked_at === deps.now.toISOString()) {
    logAuthAudit({
      event: "barestash.auth.personal_access_token.revoked",
      account_id: deps.authentication.value.accountId,
      token_id: token.id,
    });
  }

  return ok({ token: personalAccessTokenMetadata(token, deps.now) });
}

async function replayPersonalAccessToken(
  repository: AuthDomainRepository,
  record: StoredPatIdempotencyRecord,
  requestHash: string,
  now: Date,
): Promise<
  UseCaseResult<{ replayed: true; token: PersonalAccessTokenReplayResponse }>
> {
  if (record.request_hash !== requestHash) {
    return err(
      "idempotency_key_conflict",
      "The Idempotency-Key was already used with a different request.",
      409,
    );
  }

  const token = await repository.findPersonalAccessTokenById(record.token_id);

  return token === null
    ? err("internal_error", "Idempotency metadata is incomplete.", 500)
    : ok({
        replayed: true,
        token: personalAccessTokenMetadata(token, now),
      });
}

function personalAccessTokenMetadata(
  token: StoredPersonalAccessToken,
  now: Date,
): PersonalAccessTokenMetadata {
  const status =
    token.status === "active" &&
    token.expires_at !== null &&
    Date.parse(token.expires_at) <= now.getTime()
      ? "expired"
      : token.status;
  return {
    id: token.id,
    name: token.name,
    status,
    scopes: token.scopes,
    created_at: token.created_at,
    expires_at: token.expires_at,
    last_used_at: token.last_used_at,
    revoked_at: token.revoked_at,
  };
}

async function hashPatRequest(body: PersonalAccessTokenCreateRequest) {
  const canonical = JSON.stringify({
    name: normalizeTokenName(body.name),
    scopes: body.scopes,
    expires_in:
      body.expires_in === undefined
        ? DEFAULT_PAT_EXPIRATION_SECONDS
        : body.expires_in,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeTokenName(name: string | undefined): string | null {
  return typeof name === "string" && name.length > 0 ? name : null;
}
