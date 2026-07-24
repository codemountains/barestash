/** @public */
export const ID_PREFIXES = {
  accessToken: "atk_",
  account: "acc_",
  browserAccountMapping: "bam_",
  cliSession: "cls_",
  deviceAuthorization: "dva_",
  endpoint: "ep_",
  event: "evt_",
  identity: "idn_",
  patIdempotency: "pid_",
  refreshToken: "rtk_",
  token: "tok_",
  secret: "sec_",
} as const;

/** @public */
export type AccessTokenId = `${typeof ID_PREFIXES.accessToken}${string}`;

/** @public */
export type AccountId = `${typeof ID_PREFIXES.account}${string}`;

/** @public */
export type BrowserAccountMappingId =
  `${typeof ID_PREFIXES.browserAccountMapping}${string}`;

/** @public */
export type CliSessionId = `${typeof ID_PREFIXES.cliSession}${string}`;

/** @public */
export type DeviceAuthorizationId =
  `${typeof ID_PREFIXES.deviceAuthorization}${string}`;

/** @public */
export type EndpointId = `${typeof ID_PREFIXES.endpoint}${string}`;

/** @public */
export type EventId = `${typeof ID_PREFIXES.event}${string}`;

/** @public */
export type IdentityId = `${typeof ID_PREFIXES.identity}${string}`;

/** @public */
export type PatIdempotencyId = `${typeof ID_PREFIXES.patIdempotency}${string}`;

/** @public */
export type RefreshTokenId = `${typeof ID_PREFIXES.refreshToken}${string}`;

/** @public */
export type TokenId = `${typeof ID_PREFIXES.token}${string}`;

/** @public */
export type SecretId = `${typeof ID_PREFIXES.secret}${string}`;

/** @public */
export type BarestashId =
  | AccessTokenId
  | AccountId
  | BrowserAccountMappingId
  | CliSessionId
  | DeviceAuthorizationId
  | EndpointId
  | EventId
  | IdentityId
  | PatIdempotencyId
  | RefreshTokenId
  | TokenId
  | SecretId;

/** @public */
export const TOKEN_ID_SUFFIX_LENGTH = 24;

/** @public */
export const TOKEN_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** @public */
export const TOKEN_ID_SUFFIX_PATTERN = /^[A-Za-z0-9]{24}$/;

/** @public */
export const STORED_TOKEN_ID_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{24}$/;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const RANDOM_ID_SUFFIX_LENGTH = 24;

type RandomSource = {
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
};

/** @public */
export type GenerateIdOptions = {
  now?: number;
  randomBytes?: Uint8Array;
};

function getCrypto(): RandomSource {
  const crypto = (globalThis as { crypto?: RandomSource }).crypto;

  if (crypto === undefined) {
    throw new Error(
      "Web Crypto getRandomValues is required to generate Barestash IDs.",
    );
  }

  return crypto;
}

function makeRandomBytes(length: number): Uint8Array {
  return getCrypto().getRandomValues(new Uint8Array(length));
}

function getRandomBytes(
  options: GenerateIdOptions,
  length: number,
  label: string,
): Uint8Array {
  if (
    options.randomBytes !== undefined &&
    options.randomBytes.length < length
  ) {
    throw new TypeError(
      `${label} ID generation requires at least ${length} bytes of randomness.`,
    );
  }

  return options.randomBytes ?? makeRandomBytes(length);
}

function encodeUlidTime(now: number): string {
  let timestamp = Math.floor(now);
  let encoded = "";

  for (let index = 0; index < 10; index += 1) {
    const mod = timestamp % 32;
    encoded = ULID_ALPHABET[mod] + encoded;
    timestamp = Math.floor(timestamp / 32);
  }

  return encoded;
}

function generateUlid(options: GenerateIdOptions = {}): string {
  const randomBytes = getRandomBytes(options, 16, "ULID");
  let randomPart = "";

  for (let index = 0; index < 16; index += 1) {
    randomPart += ULID_ALPHABET[randomBytes[index] & 31];
  }

  return `${encodeUlidTime(options.now ?? Date.now())}${randomPart}`;
}

function generateRandomSuffix(options: GenerateIdOptions = {}): string {
  const randomBytes = getRandomBytes(
    options,
    RANDOM_ID_SUFFIX_LENGTH,
    "random",
  );
  let suffix = "";

  for (let index = 0; index < RANDOM_ID_SUFFIX_LENGTH; index += 1) {
    suffix += RANDOM_ID_ALPHABET[randomBytes[index] & 63];
  }

  return suffix;
}

/** @public */
export function generateAccountId(options?: GenerateIdOptions): AccountId {
  return `${ID_PREFIXES.account}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateIdentityId(options?: GenerateIdOptions): IdentityId {
  return `${ID_PREFIXES.identity}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateBrowserAccountMappingId(
  options?: GenerateIdOptions,
): BrowserAccountMappingId {
  return `${ID_PREFIXES.browserAccountMapping}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateDeviceAuthorizationId(
  options?: GenerateIdOptions,
): DeviceAuthorizationId {
  return `${ID_PREFIXES.deviceAuthorization}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateCliSessionId(
  options?: GenerateIdOptions,
): CliSessionId {
  return `${ID_PREFIXES.cliSession}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateAccessTokenId(
  options?: GenerateIdOptions,
): AccessTokenId {
  return `${ID_PREFIXES.accessToken}${generateTokenIdSuffix(options)}`;
}

/** @public */
export function generateRefreshTokenId(
  options?: GenerateIdOptions,
): RefreshTokenId {
  return `${ID_PREFIXES.refreshToken}${generateTokenIdSuffix(options)}`;
}

/** @public */
export function generatePatIdempotencyId(
  options?: GenerateIdOptions,
): PatIdempotencyId {
  return `${ID_PREFIXES.patIdempotency}${generateRandomSuffix(options)}`;
}

/** @public */
export function generateEndpointId(options?: GenerateIdOptions): EndpointId {
  return `${ID_PREFIXES.endpoint}${generateUlid(options)}`;
}

/** @public */
export function generateEventId(options?: GenerateIdOptions): EventId {
  return `${ID_PREFIXES.event}${generateUlid(options)}`;
}

function generateTokenIdSuffix(options: GenerateIdOptions = {}): string {
  const randomBytes = getRandomBytes(options, TOKEN_ID_SUFFIX_LENGTH, "token");
  let suffix = "";

  for (let index = 0; index < TOKEN_ID_SUFFIX_LENGTH; index += 1) {
    suffix += TOKEN_ID_ALPHABET[randomBytes[index] % TOKEN_ID_ALPHABET.length];
  }

  return suffix;
}

/** @public */
export function generateTokenId(options?: GenerateIdOptions): TokenId {
  return `${ID_PREFIXES.token}${generateTokenIdSuffix(options)}`;
}

/** @public */
export function generateSecretId(options?: GenerateIdOptions): SecretId {
  return `${ID_PREFIXES.secret}${generateRandomSuffix(options)}`;
}

function hasPrefix(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && value.length > prefix.length;
}

function assertPrefixedId<T extends BarestashId>(
  value: string,
  prefix: string,
  label: string,
): T {
  if (!hasPrefix(value, prefix)) {
    throw new TypeError(`Invalid ${label} ID: expected prefix ${prefix}`);
  }

  return value as T;
}

/** @public */
export function isAccountId(value: string): value is AccountId {
  return hasPrefix(value, ID_PREFIXES.account);
}

/** @public */
export function isIdentityId(value: string): value is IdentityId {
  return hasPrefix(value, ID_PREFIXES.identity);
}

/** @public */
export function isBrowserAccountMappingId(
  value: string,
): value is BrowserAccountMappingId {
  return hasPrefix(value, ID_PREFIXES.browserAccountMapping);
}

/** @public */
export function isDeviceAuthorizationId(
  value: string,
): value is DeviceAuthorizationId {
  return hasPrefix(value, ID_PREFIXES.deviceAuthorization);
}

/** @public */
export function isCliSessionId(value: string): value is CliSessionId {
  return hasPrefix(value, ID_PREFIXES.cliSession);
}

/** @public */
export function isAccessTokenId(value: string): value is AccessTokenId {
  return isBearerCredentialId(value, ID_PREFIXES.accessToken);
}

/** @public */
export function isRefreshTokenId(value: string): value is RefreshTokenId {
  return isBearerCredentialId(value, ID_PREFIXES.refreshToken);
}

/** @public */
export function isPatIdempotencyId(value: string): value is PatIdempotencyId {
  return hasPrefix(value, ID_PREFIXES.patIdempotency);
}

/** @public */
export function isEndpointId(value: string): value is EndpointId {
  return hasPrefix(value, ID_PREFIXES.endpoint);
}

/** @public */
export function isEventId(value: string): value is EventId {
  return hasPrefix(value, ID_PREFIXES.event);
}

/** @public */
export function isTokenId(value: string): value is TokenId {
  return isBearerCredentialId(value, ID_PREFIXES.token);
}

function isBearerCredentialId(value: string, prefix: string): boolean {
  if (!hasPrefix(value, prefix)) return false;
  const suffix = value.slice(prefix.length);
  return (
    suffix.length === TOKEN_ID_SUFFIX_LENGTH &&
    TOKEN_ID_SUFFIX_PATTERN.test(suffix)
  );
}

/** @public */
export function isStoredTokenId(value: string): value is TokenId {
  if (!hasPrefix(value, ID_PREFIXES.token)) {
    return false;
  }

  const suffix = value.slice(ID_PREFIXES.token.length);

  return (
    suffix.length === TOKEN_ID_SUFFIX_LENGTH &&
    STORED_TOKEN_ID_SUFFIX_PATTERN.test(suffix)
  );
}

/** @public */
export function isSecretId(value: string): value is SecretId {
  return hasPrefix(value, ID_PREFIXES.secret);
}

/** @public */
export function assertEndpointId(value: string): EndpointId {
  return assertPrefixedId<EndpointId>(value, ID_PREFIXES.endpoint, "endpoint");
}

/** @public */
export function assertEventId(value: string): EventId {
  return assertPrefixedId<EventId>(value, ID_PREFIXES.event, "event");
}

/** @public */
export function assertTokenId(value: string): TokenId {
  if (!isTokenId(value)) {
    throw new TypeError(
      `Invalid token ID: expected tok_ followed by ${TOKEN_ID_SUFFIX_LENGTH} alphanumeric characters`,
    );
  }

  return value as TokenId;
}

/** @public */
export function assertStoredTokenId(value: string): TokenId {
  if (!isStoredTokenId(value)) {
    throw new TypeError(
      `Invalid token ID: expected tok_ followed by ${TOKEN_ID_SUFFIX_LENGTH} stored token id characters`,
    );
  }

  return value as TokenId;
}

/** @public */
export function assertSecretId(value: string): SecretId {
  return assertPrefixedId<SecretId>(value, ID_PREFIXES.secret, "secret");
}
