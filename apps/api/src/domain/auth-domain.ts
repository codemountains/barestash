import type {
  AccessTokenStatus,
  AccountStatus,
  AuthorizationScope,
  CliSessionStatus,
  DeviceAuthorizationStatus,
  RefreshTokenStatus,
} from "@barestash/shared/auth";
import type {
  AccessTokenId,
  AccountId,
  BrowserAccountMappingId,
  CliSessionId,
  DeviceAuthorizationId,
  IdentityId,
  PatIdempotencyId,
  RefreshTokenId,
  TokenId,
} from "@barestash/shared/ids";
import type { PersonalAccessTokenStatus } from "@barestash/shared/personal-access-tokens";

/** @public */
export type IdentityProvider = "github" | "google";

/** @public */
export type StoredAccount = {
  id: AccountId;
  primary_email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: AccountStatus;
  created_at: string;
  updated_at: string;
};

/** @public */
export type StoredIdentity = {
  id: IdentityId;
  account_id: AccountId;
  provider: IdentityProvider;
  provider_subject: string;
  email: string | null;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
};

/** @public */
export type StoredBrowserAccountMapping = {
  id: BrowserAccountMappingId;
  better_auth_user_id: string;
  account_id: AccountId;
  created_at: string;
  updated_at: string;
};

/** @public */
export type StoredDeviceAuthorization = {
  id: DeviceAuthorizationId;
  device_code_hash: string;
  user_code_hash: string;
  account_id: AccountId | null;
  client_name: string;
  client_version: string | null;
  device_name: string | null;
  status: DeviceAuthorizationStatus;
  requested_scopes: AuthorizationScope[];
  expires_at: string;
  poll_interval_seconds: number;
  last_polled_at: string | null;
  created_at: string;
  approved_at: string | null;
  denied_at: string | null;
  consumed_at: string | null;
};

/** @public */
export type DeviceAuthorizationExchangeResult =
  | "exchanged"
  | "authorization_unavailable"
  | "account_disabled";

/** @public */
export type StoredCliSession = {
  id: CliSessionId;
  account_id: AccountId;
  device_name: string | null;
  client_version: string | null;
  status: CliSessionStatus;
  scopes: AuthorizationScope[];
  created_at: string;
  last_used_at: string | null;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  compromised_at: string | null;
};

/** @public */
export type StoredAccessToken = {
  id: AccessTokenId;
  session_id: CliSessionId;
  token_hash: string;
  status: AccessTokenStatus;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export type StoredRefreshToken = {
  id: RefreshTokenId;
  session_id: CliSessionId;
  token_hash: string;
  token_family_id: string;
  status: RefreshTokenStatus;
  parent_token_id: RefreshTokenId | null;
  replaced_by_token_id: RefreshTokenId | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export type StoredPersonalAccessToken = {
  id: TokenId;
  account_id: AccountId;
  name: string | null;
  token_hash: string;
  status: PersonalAccessTokenStatus;
  scopes: AuthorizationScope[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export type StoredPatIdempotencyRecord = {
  id: PatIdempotencyId;
  account_id: AccountId;
  idempotency_key: string;
  request_hash: string;
  token_id: TokenId;
  created_at: string;
  expires_at: string;
};

/** @public */
export type AuthDomainRecords = {
  account: StoredAccount;
  identity: StoredIdentity;
  browserAccountMapping: StoredBrowserAccountMapping;
  deviceAuthorization: StoredDeviceAuthorization;
  cliSession: StoredCliSession;
  accessToken: StoredAccessToken;
  refreshToken: StoredRefreshToken;
  personalAccessToken: StoredPersonalAccessToken;
  patIdempotency: StoredPatIdempotencyRecord;
};

export type AccountRepository = {
  createAccount(record: StoredAccount): Promise<void>;
  createAccountIfAbsent(record: StoredAccount): Promise<void>;
  findAccountById(id: AccountId): Promise<StoredAccount | null>;
};

export type IdentityRepository = {
  createIdentity(record: StoredIdentity): Promise<void>;
  findIdentityByProvider(
    provider: IdentityProvider,
    providerSubject: string,
  ): Promise<StoredIdentity | null>;
};

export type BrowserAccountMappingRepository = {
  createBrowserAccountMapping(
    record: StoredBrowserAccountMapping,
  ): Promise<void>;
  findBrowserAccountMappingByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<StoredBrowserAccountMapping | null>;
};

export type DeviceAuthorizationRepository = {
  createDeviceAuthorization(
    record: StoredDeviceAuthorization,
  ): Promise<"created" | "user_code_conflict">;
  findDeviceAuthorizationByDeviceCodeHash(
    deviceCodeHash: string,
  ): Promise<StoredDeviceAuthorization | null>;
  findDeviceAuthorizationByUserCodeHash(
    userCodeHash: string,
  ): Promise<StoredDeviceAuthorization | null>;
  recordDeviceAuthorizationPoll(
    id: DeviceAuthorizationId,
    polledAt: string,
    allowedBefore: string,
  ): Promise<boolean>;
  approveDeviceAuthorization(
    id: DeviceAuthorizationId,
    accountId: AccountId,
    approvedAt: string,
  ): Promise<StoredDeviceAuthorization | null>;
  denyDeviceAuthorization(
    id: DeviceAuthorizationId,
    deniedAt: string,
  ): Promise<StoredDeviceAuthorization | null>;
  expireDeviceAuthorization(
    id: DeviceAuthorizationId,
  ): Promise<StoredDeviceAuthorization | null>;
  exchangeDeviceAuthorization(
    authorizationId: DeviceAuthorizationId,
    session: StoredCliSession,
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    consumedAt: string,
  ): Promise<DeviceAuthorizationExchangeResult>;
};

export type CliSessionRepository = {
  createCliSession(record: StoredCliSession): Promise<void>;
  findCliSessionById(id: CliSessionId): Promise<StoredCliSession | null>;
  updateCliSessionLastUsed(id: CliSessionId, lastUsedAt: string): Promise<void>;
};

export type AccessTokenRepository = {
  createAccessToken(record: StoredAccessToken): Promise<void>;
  findAccessTokenById(id: AccessTokenId): Promise<StoredAccessToken | null>;
  updateAccessTokenLastUsed(
    id: AccessTokenId,
    lastUsedAt: string,
  ): Promise<void>;
};

export type RefreshTokenRepository = {
  createRefreshToken(record: StoredRefreshToken): Promise<void>;
  findRefreshTokenById(id: RefreshTokenId): Promise<StoredRefreshToken | null>;
  rotateRefreshToken(
    currentTokenId: RefreshTokenId,
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    lastUsedAt: string,
    idleExpiresAt: string,
  ): Promise<
    | "rotated"
    | "reuse_detected"
    | "session_unavailable"
    | "session_expired"
    | "account_disabled"
  >;
  compromiseCliSession(
    sessionId: CliSessionId,
    tokenFamilyId: string,
    compromisedAt: string,
  ): Promise<void>;
  revokeCliSession(
    sessionId: CliSessionId,
    revokedAt: string,
  ): Promise<StoredCliSession | null>;
};

export type PersonalAccessTokenRepository = {
  createPersonalAccessToken(record: StoredPersonalAccessToken): Promise<void>;
  findPersonalAccessTokenById(
    id: TokenId,
  ): Promise<StoredPersonalAccessToken | null>;
  updatePersonalAccessTokenLastUsed(
    id: TokenId,
    lastUsedAt: string,
  ): Promise<void>;
  listPersonalAccessTokens(
    accountId: AccountId,
    options: { includeInactive: boolean; now: Date },
  ): Promise<StoredPersonalAccessToken[]>;
  revokePersonalAccessToken(
    id: TokenId,
    accountId: AccountId,
    revokedAt: string,
  ): Promise<StoredPersonalAccessToken | null>;
};

export type PatIdempotencyRepository = {
  createPatIdempotencyRecord(record: StoredPatIdempotencyRecord): Promise<void>;
  findPatIdempotencyRecord(
    accountId: AccountId,
    idempotencyKey: string,
    now?: Date,
  ): Promise<StoredPatIdempotencyRecord | null>;
  createPersonalAccessTokenIdempotently(
    token: StoredPersonalAccessToken,
    idempotency: StoredPatIdempotencyRecord,
  ): Promise<"created" | "existing">;
};

/** @public */
export type AuthDomainRepository = AccountRepository &
  IdentityRepository &
  BrowserAccountMappingRepository &
  DeviceAuthorizationRepository &
  CliSessionRepository &
  AccessTokenRepository &
  RefreshTokenRepository &
  PersonalAccessTokenRepository &
  PatIdempotencyRepository;
