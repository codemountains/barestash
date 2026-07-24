import type { RefreshTokenResponse } from "@barestash/shared/auth";
import { parseBearerTokenString } from "@barestash/shared/bearer-tokens";
import {
  type AccessTokenId,
  type CliSessionId,
  ID_PREFIXES,
  type RefreshTokenId,
} from "@barestash/shared/ids";

import type {
  AuthDomainRepository,
  StoredAccessToken,
  StoredCliSession,
  StoredRefreshToken,
} from "../domain/auth-domain.js";
import { logAuthAudit } from "./auth-audit.js";
import { hashCredential, verifyCredential } from "./credential-hash.js";
import { err, ok, type UseCaseResult } from "./result.js";

const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const CLI_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;

export type RefreshCliSessionInput = {
  repository: AuthDomainRepository;
  refreshToken: string;
  now: Date;
  credentialPepper?: string;
  makeAccessTokenId: () => AccessTokenId;
  makeRefreshTokenId: () => RefreshTokenId;
  makeAccessToken: (id: AccessTokenId) => string;
  makeRefreshToken: (id: RefreshTokenId) => string;
};

/** @public */
export async function refreshCliSession(
  input: RefreshCliSessionInput,
): Promise<UseCaseResult<RefreshTokenResponse>> {
  const parsed = parseBearerTokenString(input.refreshToken);
  if (parsed?.type !== "refresh") return invalidRefreshToken();
  const tokenId =
    `${ID_PREFIXES.refreshToken}${parsed.tokenIdSuffix}` as RefreshTokenId;
  const current = await input.repository.findRefreshTokenById(tokenId);
  if (current === null) return invalidRefreshToken();
  if (
    !(await verifyCredential(parsed.secret, current.token_hash, {
      pepper: input.credentialPepper ?? "",
    }))
  ) {
    return invalidRefreshToken();
  }
  if (current.status === "used") {
    const compromisedSession = await input.repository.findCliSessionById(
      current.session_id,
    );
    await input.repository.compromiseCliSession(
      current.session_id,
      current.token_family_id,
      input.now.toISOString(),
    );
    if (compromisedSession !== null) {
      logCompromisedSession(compromisedSession, current.id);
    }
    return refreshReuseDetected();
  }
  if (current.status === "revoked") {
    return err(
      "refresh_token_revoked",
      "The refresh token has been revoked.",
      401,
    );
  }
  if (
    current.status === "expired" ||
    Date.parse(current.expires_at) <= input.now.getTime()
  ) {
    return err("refresh_token_expired", "The refresh token has expired.", 401);
  }
  const session = await input.repository.findCliSessionById(current.session_id);
  if (session === null) return invalidRefreshToken();
  if (session.status !== "active") {
    return err("session_revoked", "The CLI session has been revoked.", 401);
  }
  if (
    Date.parse(session.idle_expires_at) <= input.now.getTime() ||
    Date.parse(session.absolute_expires_at) <= input.now.getTime()
  ) {
    return err("session_expired", "The CLI session has expired.", 401);
  }
  const account = await input.repository.findAccountById(session.account_id);
  if (account === null) return invalidRefreshToken();
  if (account.status === "disabled") {
    return err("account_disabled", "The account is disabled.", 401);
  }

  const accessTokenId = input.makeAccessTokenId();
  const refreshTokenId = input.makeRefreshTokenId();
  const accessToken = input.makeAccessToken(accessTokenId);
  const refreshToken = input.makeRefreshToken(refreshTokenId);
  const accessParsed = parseBearerTokenString(accessToken);
  const refreshParsed = parseBearerTokenString(refreshToken);
  if (accessParsed?.type !== "access" || refreshParsed?.type !== "refresh") {
    throw new Error("Generated CLI token has an invalid format.");
  }
  const now = input.now.toISOString();
  const accessExpiresAt = addSeconds(input.now, ACCESS_TOKEN_LIFETIME_SECONDS);
  const idleExpiresAt = addSeconds(input.now, CLI_SESSION_IDLE_SECONDS);
  const nextAccess: StoredAccessToken = {
    id: accessTokenId,
    session_id: session.id,
    token_hash: await hashCredential(accessParsed.secret, {
      pepper: input.credentialPepper ?? "",
    }),
    status: "active",
    created_at: now,
    expires_at: accessExpiresAt.toISOString(),
    last_used_at: null,
    revoked_at: null,
  };
  const nextRefresh: StoredRefreshToken = {
    id: refreshTokenId,
    session_id: session.id,
    token_hash: await hashCredential(refreshParsed.secret, {
      pepper: input.credentialPepper ?? "",
    }),
    token_family_id: current.token_family_id,
    status: "active",
    parent_token_id: current.id,
    replaced_by_token_id: null,
    created_at: now,
    expires_at: session.absolute_expires_at,
    used_at: null,
    revoked_at: null,
  };
  const rotated = await input.repository.rotateRefreshToken(
    current.id,
    nextAccess,
    nextRefresh,
    now,
    idleExpiresAt.toISOString(),
  );
  if (rotated === "reuse_detected") {
    logCompromisedSession(session, current.id);
    return refreshReuseDetected();
  }
  if (rotated === "session_expired") {
    return err("session_expired", "The CLI session has expired.", 401);
  }
  if (rotated === "account_disabled") {
    return err("account_disabled", "The account is disabled.", 401);
  }
  if (rotated !== "rotated") {
    return err("session_revoked", "The CLI session has been revoked.", 401);
  }
  logAuthAudit({
    event: "barestash.auth.access_token.refreshed",
    account_id: session.account_id,
    session_id: session.id,
    access_token_id: accessTokenId,
    refresh_token_id: refreshTokenId,
  });
  return ok({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
    refresh_token_expires_in: Math.max(
      0,
      Math.floor(
        (Date.parse(session.absolute_expires_at) - input.now.getTime()) / 1_000,
      ),
    ),
  });
}

/** @public */
export async function revokeCliSession(input: {
  repository: AuthDomainRepository;
  sessionId: CliSessionId;
  now: Date;
}) {
  const session = await input.repository.revokeCliSession(
    input.sessionId,
    input.now.toISOString(),
  );
  if (session === null) {
    return err("invalid_token", "The CLI session is invalid.", 401);
  }
  if (session.revoked_at === input.now.toISOString()) {
    logAuthAudit({
      event: "barestash.auth.cli_session.revoked",
      account_id: session.account_id,
      session_id: session.id,
    });
  }
  return ok({
    session: {
      id: session.id,
      status: session.status,
      revoked_at: session.revoked_at ?? input.now.toISOString(),
    },
  });
}

function logCompromisedSession(
  session: StoredCliSession,
  refreshTokenId: RefreshTokenId,
): void {
  logAuthAudit({
    event: "barestash.auth.cli_session.compromised",
    account_id: session.account_id,
    session_id: session.id,
  });
  logAuthAudit({
    event: "barestash.auth.refresh_token.reuse_detected",
    account_id: session.account_id,
    session_id: session.id,
    refresh_token_id: refreshTokenId,
  });
}

function invalidRefreshToken() {
  return err("invalid_token", "The refresh token is invalid.", 401);
}

function refreshReuseDetected() {
  return err(
    "refresh_token_reuse_detected",
    "The CLI session has been revoked. Sign in again.",
    401,
  );
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}
