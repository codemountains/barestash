import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type DeviceAuthorizationCreateRequest,
  type DeviceAuthorizationCreateResponse,
  type DeviceTokenResponse,
} from "@barestash/shared/auth";
import {
  formatBearerTokenString,
  parseBearerTokenString,
} from "@barestash/shared/bearer-tokens";
import {
  type AccessTokenId,
  type CliSessionId,
  type DeviceAuthorizationId,
  ID_PREFIXES,
  type RefreshTokenId,
} from "@barestash/shared/ids";

import type {
  AuthDomainRepository,
  StoredAccessToken,
  StoredCliSession,
  StoredDeviceAuthorization,
  StoredRefreshToken,
} from "../domain/auth-domain.js";
import { logAuthAudit } from "./auth-audit.js";
import { hashCredential } from "./credential-hash.js";
import { err, ok, type UseCaseResult } from "./result.js";

export const DEVICE_AUTHORIZATION_LIFETIME_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const ACCESS_TOKEN_LIFETIME_SECONDS = 3_600;
export const CLI_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const CLI_SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;
const USER_CODE_PATTERN = /^[A-HJ-KM-NP-Z]{8}$/;
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ";
const USER_CODE_GENERATION_ATTEMPTS = 5;

type CreateInput = {
  repository: AuthDomainRepository;
  body: Omit<DeviceAuthorizationCreateRequest, "requested_scopes"> & {
    requested_scopes: readonly string[];
  };
  now: Date;
  credentialPepper: string;
  verificationUri: string;
  makeDeviceAuthorizationId: () => DeviceAuthorizationId;
  makeDeviceCode: () => string;
  makeUserCode: () => string;
};

/** @public */
export async function createDeviceAuthorization(
  input: CreateInput,
): Promise<UseCaseResult<DeviceAuthorizationCreateResponse>> {
  const bodyError = validateCreateBody(input.body);
  if (bodyError !== null) return bodyError;

  const requestedScopes = input.body.requested_scopes as AuthorizationScope[];
  const deviceCode = input.makeDeviceCode();
  if (!isValidDeviceCode(deviceCode)) {
    return err(
      "internal_error",
      "Device Authorization code generation failed.",
      500,
    );
  }
  const createdAt = input.now.toISOString();
  const expiresAt = addSeconds(
    input.now,
    DEVICE_AUTHORIZATION_LIFETIME_SECONDS,
  ).toISOString();
  const deviceAuthorizationId = input.makeDeviceAuthorizationId();
  const deviceCodeHash = await hashCredential(deviceCode, {
    pepper: input.credentialPepper,
  });

  for (let attempt = 0; attempt < USER_CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const userCode = formatUserCode(input.makeUserCode());
    if (userCode === null) {
      return err(
        "internal_error",
        "Device Authorization code generation failed.",
        500,
      );
    }
    const creation = await input.repository.createDeviceAuthorization({
      id: deviceAuthorizationId,
      device_code_hash: deviceCodeHash,
      user_code_hash: await hashCredential(normalizeUserCode(userCode), {
        pepper: input.credentialPepper,
      }),
      account_id: null,
      client_name: input.body.client_name.trim(),
      client_version: optionalTrimmed(input.body.client_version),
      device_name: optionalTrimmed(input.body.device_name),
      status: "pending",
      requested_scopes: requestedScopes.slice(),
      expires_at: expiresAt,
      poll_interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
      last_polled_at: null,
      created_at: createdAt,
      approved_at: null,
      denied_at: null,
      consumed_at: null,
    });
    if (creation === "user_code_conflict") continue;

    const verificationUri = new URL(input.verificationUri);
    const complete = new URL(verificationUri);
    complete.searchParams.set("code", userCode);
    logAuthAudit({
      event: "barestash.auth.device_authorization.created",
      device_authorization_id: deviceAuthorizationId,
    });
    return ok({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri.toString(),
      verification_uri_complete: complete.toString(),
      expires_in: DEVICE_AUTHORIZATION_LIFETIME_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  }

  return err(
    "internal_error",
    "Device Authorization user code generation failed.",
    500,
  );
}

type PollInput = {
  repository: AuthDomainRepository;
  deviceCode: string;
  now: Date;
  credentialPepper: string;
  makeCliSessionId: () => CliSessionId;
  makeAccessTokenId: () => AccessTokenId;
  makeRefreshTokenId: () => RefreshTokenId;
  makeAccessToken: (id: AccessTokenId) => string;
  makeRefreshToken: (id: RefreshTokenId) => string;
};

/** @public */
export async function pollDeviceAuthorizationToken(
  input: PollInput,
): Promise<UseCaseResult<DeviceTokenResponse>> {
  if (!isValidDeviceCode(input.deviceCode)) return invalidDeviceCode();
  const authorization =
    await input.repository.findDeviceAuthorizationByDeviceCodeHash(
      await hashCredential(input.deviceCode, {
        pepper: input.credentialPepper,
      }),
    );
  if (authorization === null) return invalidDeviceCode();

  const allowedBefore = addSeconds(
    input.now,
    -authorization.poll_interval_seconds,
  ).toISOString();
  const recorded = await input.repository.recordDeviceAuthorizationPoll(
    authorization.id,
    input.now.toISOString(),
    allowedBefore,
  );
  if (!recorded) {
    return err(
      "slow_down",
      "Polling is faster than the allowed interval.",
      400,
    );
  }

  if (authorization.status === "denied") {
    return err("authorization_denied", "Authorization was denied.", 400);
  }
  if (authorization.status === "expired") {
    return err("device_code_expired", "The device code has expired.", 400);
  }
  if (authorization.status === "consumed") {
    return err(
      "device_code_consumed",
      "The device code was already used.",
      400,
    );
  }
  if (Date.parse(authorization.expires_at) <= input.now.getTime()) {
    await input.repository.expireDeviceAuthorization(authorization.id);
    return err("device_code_expired", "The device code has expired.", 400);
  }
  if (authorization.status === "pending") {
    return err("authorization_pending", "Authorization is still pending.", 400);
  }
  if (authorization.account_id === null) return invalidDeviceCode();
  const approvedAt =
    authorization.approved_at === null
      ? null
      : new Date(authorization.approved_at);
  if (
    approvedAt === null ||
    !Number.isFinite(approvedAt.getTime()) ||
    approvedAt.getTime() > input.now.getTime()
  ) {
    return err("internal_error", "The approval timestamp is invalid.", 500);
  }

  const account = await input.repository.findAccountById(
    authorization.account_id,
  );
  if (account === null || account.status === "disabled") {
    return err("account_disabled", "The account is disabled.", 401);
  }

  const accessTokenId = input.makeAccessTokenId();
  const refreshTokenId = input.makeRefreshTokenId();
  const accessToken = input.makeAccessToken(accessTokenId);
  const refreshToken = input.makeRefreshToken(refreshTokenId);
  const accessParsed = parseBearerTokenString(accessToken);
  const refreshParsed = parseBearerTokenString(refreshToken);
  if (accessParsed?.type !== "access" || refreshParsed?.type !== "refresh") {
    return err("internal_error", "Token generation failed.", 500);
  }
  const sessionId = input.makeCliSessionId();
  const records = await exchangeRecords({
    authorization,
    accountId: authorization.account_id,
    sessionId,
    accessTokenId,
    refreshTokenId,
    accessSecret: accessParsed.secret,
    refreshSecret: refreshParsed.secret,
    now: input.now,
    approvedAt,
    credentialPepper: input.credentialPepper,
  });
  const exchange = await input.repository.exchangeDeviceAuthorization(
    authorization.id,
    records.session,
    records.accessToken,
    records.refreshToken,
    input.now.toISOString(),
  );
  if (exchange === "account_disabled") {
    return err("account_disabled", "The account is disabled.", 401);
  }
  if (exchange === "authorization_unavailable") {
    return err(
      "device_code_consumed",
      "The device code was already used.",
      400,
    );
  }

  logAuthAudit({
    event: "barestash.auth.cli_session.created",
    account_id: authorization.account_id,
    session_id: sessionId,
    device_authorization_id: authorization.id,
  });

  const refreshTokenExpiresIn = Math.max(
    0,
    Math.floor(
      (Date.parse(records.session.absolute_expires_at) - input.now.getTime()) /
        1_000,
    ),
  );
  return ok({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
    refresh_token_expires_in: refreshTokenExpiresIn,
    scopes: authorization.requested_scopes,
  });
}

function validateCreateBody(
  body: CreateInput["body"],
): UseCaseResult<never> | null {
  if (typeof body.client_name !== "string" || body.client_name.trim() === "") {
    return err("invalid_request", "client_name is required.", 400);
  }
  if (
    (body.client_version !== undefined &&
      typeof body.client_version !== "string") ||
    (body.device_name !== undefined && typeof body.device_name !== "string")
  ) {
    return err(
      "invalid_request",
      "client_version and device_name must be strings when provided.",
      400,
    );
  }
  if (
    !Array.isArray(body.requested_scopes) ||
    body.requested_scopes.length === 0
  ) {
    return err("invalid_request", "requested_scopes must not be empty.", 400);
  }
  const supported = new Set<string>(AUTHORIZATION_SCOPES);
  const unknown = body.requested_scopes.find(
    (scope) => typeof scope !== "string" || !supported.has(scope),
  );
  if (unknown !== undefined) {
    return err(
      "invalid_request",
      `Unsupported requested scope: ${String(unknown)}.`,
      400,
    );
  }
  if (new Set(body.requested_scopes).size !== body.requested_scopes.length) {
    return err(
      "invalid_request",
      "requested_scopes must not contain duplicates.",
      400,
    );
  }
  return null;
}

function invalidDeviceCode(): UseCaseResult<never> {
  return err("invalid_device_code", "The device code is invalid.", 400);
}

export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[-\s]/g, "");
}

export function formatUserCode(value: string): string | null {
  const normalized = normalizeUserCode(value);
  return USER_CODE_PATTERN.test(normalized)
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : null;
}

function isValidDeviceCode(value: string): boolean {
  return /^bst_device_[A-Za-z0-9]{32,}$/.test(value);
}

function optionalTrimmed(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

async function exchangeRecords(input: {
  authorization: StoredDeviceAuthorization;
  accountId: StoredCliSession["account_id"];
  sessionId: CliSessionId;
  accessTokenId: AccessTokenId;
  refreshTokenId: RefreshTokenId;
  accessSecret: string;
  refreshSecret: string;
  now: Date;
  approvedAt: Date;
  credentialPepper: string;
}): Promise<{
  session: StoredCliSession;
  accessToken: StoredAccessToken;
  refreshToken: StoredRefreshToken;
}> {
  const now = input.now.toISOString();
  const absoluteExpiresAt = addSeconds(
    input.approvedAt,
    CLI_SESSION_ABSOLUTE_SECONDS,
  ).toISOString();
  return {
    session: {
      id: input.sessionId,
      account_id: input.accountId,
      device_name: input.authorization.device_name,
      client_version: input.authorization.client_version,
      status: "active",
      scopes: input.authorization.requested_scopes,
      created_at: now,
      last_used_at: null,
      idle_expires_at: addSeconds(
        input.approvedAt,
        CLI_SESSION_IDLE_SECONDS,
      ).toISOString(),
      absolute_expires_at: absoluteExpiresAt,
      revoked_at: null,
      compromised_at: null,
    },
    accessToken: {
      id: input.accessTokenId,
      session_id: input.sessionId,
      token_hash: await hashCredential(input.accessSecret, {
        pepper: input.credentialPepper,
      }),
      status: "active",
      created_at: now,
      expires_at: addSeconds(
        input.now,
        ACCESS_TOKEN_LIFETIME_SECONDS,
      ).toISOString(),
      last_used_at: null,
      revoked_at: null,
    },
    refreshToken: {
      id: input.refreshTokenId,
      session_id: input.sessionId,
      token_hash: await hashCredential(input.refreshSecret, {
        pepper: input.credentialPepper,
      }),
      token_family_id: input.sessionId,
      status: "active",
      parent_token_id: null,
      replaced_by_token_id: null,
      created_at: now,
      expires_at: absoluteExpiresAt,
      used_at: null,
      revoked_at: null,
    },
  };
}

/** @public */
export function formatAccessToken(id: AccessTokenId, secret: string): string {
  return formatBearerTokenString({
    type: "access",
    tokenIdSuffix: id.slice(ID_PREFIXES.accessToken.length),
    secret,
  });
}

/** @public */
export function formatRefreshToken(id: RefreshTokenId, secret: string): string {
  return formatBearerTokenString({
    type: "refresh",
    tokenIdSuffix: id.slice(ID_PREFIXES.refreshToken.length),
    secret,
  });
}

/** @public */
export function generateDeviceCode(): string {
  return `bst_device_${randomCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 32)}`;
}

/** @public */
export function generateUserCode(): string {
  return randomCharacters(USER_CODE_ALPHABET, 8);
}

function randomCharacters(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
