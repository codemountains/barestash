import type { AuthorizationScope, AuthPrincipal } from "@barestash/shared/auth";
import { parseBearerTokenString } from "@barestash/shared/bearer-tokens";
import type { RestErrorCode } from "@barestash/shared/errors";
import {
  type AccessTokenId,
  ID_PREFIXES,
  type TokenId,
} from "@barestash/shared/ids";
import type { PersonalAccessTokenMetadata } from "@barestash/shared/personal-access-tokens";

import type { AuthDomainRepository } from "../domain/auth-domain.js";
import type { AuthenticatedAccount } from "../domain/token.js";
import {
  type CredentialHashOptions,
  verifyCredential,
} from "./credential-hash.js";
import { err, ok, type UseCaseError, type UseCaseResult } from "./result.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type AuthenticationOptions = CredentialHashOptions;

export type CredentialPepperDeps = {
  credentialPepper?: string;
};

/** @public */
export type PrincipalAuthenticationResult =
  | { kind: "ok"; value: AuthPrincipal }
  | (UseCaseError & {
      verifiedRevokedPersonalAccessToken?: PersonalAccessTokenMetadata;
    });

/** @public */
export async function authenticateBearerPrincipal(
  authorizationHeader: string | null,
  repository: AuthDomainRepository,
  now: Date,
  options: AuthenticationOptions = {},
  updateLastUsed = true,
): Promise<PrincipalAuthenticationResult> {
  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);

  if (match === undefined || match === null || match[1] === undefined) {
    return err("not_authenticated", "Authentication is required.", 401);
  }

  const parsed = parseBearerTokenString(match[1]);

  if (parsed === null || parsed.type === "refresh") {
    return invalidCredential("invalid_token", "The bearer token is invalid.");
  }

  if (parsed.type === "pat") {
    const tokenId = `${ID_PREFIXES.token}${parsed.tokenIdSuffix}` as TokenId;
    const token = await repository.findPersonalAccessTokenById(tokenId);

    if (token === null) {
      return invalidCredential("invalid_token", "The bearer token is invalid.");
    }

    const verified = await verifyCredential(
      parsed.secret,
      token.token_hash,
      options,
    );

    if (!verified) {
      return invalidCredential("invalid_token", "The bearer token is invalid.");
    }

    if (token.status === "revoked") {
      return {
        ...invalidCredential("token_revoked", "The token has been revoked."),
        verifiedRevokedPersonalAccessToken: {
          id: token.id,
          name: token.name,
          status: "revoked",
          scopes: token.scopes,
          created_at: token.created_at,
          expires_at: token.expires_at,
          last_used_at: token.last_used_at,
          revoked_at: token.revoked_at,
        },
      };
    }

    if (
      token.status === "expired" ||
      (token.expires_at !== null &&
        Date.parse(token.expires_at) <= now.getTime())
    ) {
      return invalidCredential(
        "personal_access_token_expired",
        "The Personal Access Token has expired.",
      );
    }

    const account = await repository.findAccountById(token.account_id);
    const accountError = validateAccount(account);

    if (accountError !== null) return accountError;

    const principal: AuthPrincipal = {
      accountId: token.account_id,
      credential: {
        type: "personal_access_token",
        id: token.id,
        scopes: token.scopes,
        expiresAt: token.expires_at,
      },
    };

    if (updateLastUsed) {
      await recordPrincipalLastUsed(principal, repository, now);
    }

    return ok(principal);
  }

  const accessTokenId =
    `${ID_PREFIXES.accessToken}${parsed.tokenIdSuffix}` as AccessTokenId;
  const token = await repository.findAccessTokenById(accessTokenId);

  if (token === null) {
    return invalidCredential("invalid_token", "The bearer token is invalid.");
  }

  const verified = await verifyCredential(
    parsed.secret,
    token.token_hash,
    options,
  );

  if (!verified) {
    return invalidCredential("invalid_token", "The bearer token is invalid.");
  }

  if (token.status === "revoked") {
    return invalidCredential("token_revoked", "The token has been revoked.");
  }

  if (
    token.status === "expired" ||
    Date.parse(token.expires_at) <= now.getTime()
  ) {
    return invalidCredential(
      "access_token_expired",
      "The access token has expired.",
    );
  }

  const session = await repository.findCliSessionById(token.session_id);

  if (session === null) {
    return invalidCredential("invalid_token", "The bearer token is invalid.");
  }

  if (session.status === "revoked" || session.status === "compromised") {
    return invalidCredential(
      "session_revoked",
      "The CLI session has been revoked.",
    );
  }

  if (
    session.status === "expired" ||
    Date.parse(session.idle_expires_at) <= now.getTime() ||
    Date.parse(session.absolute_expires_at) <= now.getTime()
  ) {
    return invalidCredential("session_expired", "The CLI session has expired.");
  }

  const account = await repository.findAccountById(session.account_id);
  const accountError = validateAccount(account);

  if (accountError !== null) return accountError;

  const principal: AuthPrincipal = {
    accountId: session.account_id,
    credential: {
      type: "cli_access_token",
      id: token.id,
      sessionId: session.id,
      scopes: session.scopes,
      expiresAt: token.expires_at,
    },
  };

  if (updateLastUsed) {
    await recordPrincipalLastUsed(principal, repository, now);
  }

  return ok(principal);
}

/** @public */
export async function recordPrincipalLastUsed(
  principal: AuthPrincipal,
  repository: AuthDomainRepository,
  now: Date,
): Promise<void> {
  const lastUsedAt = now.toISOString();

  if (principal.credential.type === "personal_access_token") {
    await repository.updatePersonalAccessTokenLastUsed(
      principal.credential.id,
      lastUsedAt,
    );
    return;
  }

  await repository.updateAccessTokenLastUsed(
    principal.credential.id,
    lastUsedAt,
  );
  await repository.updateCliSessionLastUsed(
    principal.credential.sessionId,
    lastUsedAt,
  );
}

/** @public */
export function requireScope(
  principal: AuthPrincipal,
  requiredScope: AuthorizationScope,
): UseCaseResult<AuthPrincipal> {
  return principal.credential.scopes.includes(requiredScope)
    ? ok(principal)
    : err(
        "insufficient_scope",
        `This token does not have the required scope: ${requiredScope}.`,
        403,
      );
}

export function requireRequestedScopesSubset(
  principal: AuthPrincipal,
  requestedScopes: AuthorizationScope[],
): UseCaseResult<AuthPrincipal> {
  const disallowedScope = requestedScopes.find(
    (scope) => !principal.credential.scopes.includes(scope),
  );

  return disallowedScope === undefined
    ? ok(principal)
    : err(
        "insufficient_scope",
        `The requested scope is not granted to this credential: ${disallowedScope}.`,
        403,
      );
}

export function requireEndpointOwner(
  principal: AuthPrincipal,
  endpoint: { id: string; account_id?: string | null },
): UseCaseResult<AuthPrincipal> {
  return endpoint.account_id === principal.accountId
    ? ok(principal)
    : err(
        "not_authorized",
        `Not authorized to access endpoint: ${endpoint.id}`,
        403,
      );
}

function validateAccount(
  account: Awaited<ReturnType<AuthDomainRepository["findAccountById"]>>,
): UseCaseResult<never> | null {
  if (account === null) {
    return invalidCredential("invalid_token", "The bearer token is invalid.");
  }

  return account.status === "disabled"
    ? invalidCredential("account_disabled", "The account is disabled.")
    : null;
}

function invalidCredential(code: RestErrorCode, message: string): UseCaseError {
  return err(code, message, 401);
}

export async function authenticateRequest(
  authorizationHeader: string | null,
  repository: AuthDomainRepository,
  now: Date,
  options: AuthenticationOptions = {},
): Promise<UseCaseResult<AuthenticatedAccount>> {
  const authenticated = await authenticateResourcePrincipal(
    authorizationHeader,
    repository,
    now,
    options,
  );

  return authenticated.kind === "error"
    ? authenticated
    : ok({
        accountId: authenticated.value.accountId,
        tokenId: authenticated.value.credential.id,
      });
}

/** @public */
export async function authenticateResourcePrincipal(
  authorizationHeader: string | null,
  repository: AuthDomainRepository,
  now: Date,
  options: AuthenticationOptions = {},
  updateLastUsed = true,
): Promise<PrincipalAuthenticationResult> {
  const authenticated = await authenticateBearerPrincipal(
    authorizationHeader,
    repository,
    now,
    options,
    false,
  );

  if (authenticated.kind === "ok") {
    if (updateLastUsed) {
      await recordPrincipalLastUsed(authenticated.value, repository, now);
    }
  }

  return authenticated;
}

export async function verifyRequestAuthentication(
  authorizationHeader: string | null,
  repository: AuthDomainRepository,
  options: AuthenticationOptions = {},
  now = new Date(),
): Promise<UseCaseResult<AuthenticatedAccount>> {
  const authenticated = await authenticateBearerPrincipal(
    authorizationHeader,
    repository,
    now,
    options,
    false,
  );
  return authenticated.kind === "error"
    ? authenticated
    : ok({
        accountId: authenticated.value.accountId,
        tokenId: authenticated.value.credential.id,
      });
}
