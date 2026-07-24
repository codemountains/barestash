import {
  ID_PREFIXES,
  isTokenId,
  TOKEN_ID_ALPHABET,
  TOKEN_ID_SUFFIX_LENGTH,
  type TokenId,
} from "./ids.js";

/** @public */
export const BEARER_TOKEN_TYPES = ["access", "refresh", "pat"] as const;

/** @public */
export type BearerTokenType = (typeof BEARER_TOKEN_TYPES)[number];

/** @public */
export const BEARER_TOKEN_SECRET_LENGTH = 32;

const BEARER_TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9]+$/;

/** @public */
export type ParsedBearerToken = {
  type: BearerTokenType;
  tokenIdSuffix: string;
  secret: string;
};

/** @public */
export function isBearerTokenType(value: string): value is BearerTokenType {
  return (BEARER_TOKEN_TYPES as readonly string[]).includes(value);
}

/** @public */
export function parseBearerTokenString(
  value: string,
): ParsedBearerToken | null {
  const parts = value.split("_");

  if (parts.length !== 4 || parts[0] !== "bst") {
    return null;
  }

  const type = parts[1];

  if (!isBearerTokenType(type)) {
    return null;
  }

  const tokenIdSuffix = parts[2];
  const secret = parts[3];

  if (
    tokenIdSuffix.length !== TOKEN_ID_SUFFIX_LENGTH ||
    secret.length !== BEARER_TOKEN_SECRET_LENGTH ||
    !BEARER_TOKEN_SEGMENT_PATTERN.test(tokenIdSuffix) ||
    !BEARER_TOKEN_SEGMENT_PATTERN.test(secret)
  ) {
    return null;
  }

  return {
    type,
    tokenIdSuffix,
    secret,
  };
}

/** @public */
export function formatBearerTokenString(parts: ParsedBearerToken): string {
  return `bst_${parts.type}_${parts.tokenIdSuffix}_${parts.secret}`;
}

/** @public */
export function tokenIdFromBearerTokenString(value: string): TokenId | null {
  const parsed = parseBearerTokenString(value);

  if (parsed === null) {
    return null;
  }

  const tokenId = `${ID_PREFIXES.token}${parsed.tokenIdSuffix}`;

  return isTokenId(tokenId) ? tokenId : null;
}

/** @public */
export type GenerateBearerSecretOptions = {
  randomBytes?: Uint8Array;
};

function getBearerSecretRandomBytes(
  options: GenerateBearerSecretOptions,
  length: number,
): Uint8Array {
  if (options.randomBytes !== undefined) {
    if (options.randomBytes.length < length) {
      throw new TypeError(
        `Bearer token secret generation requires at least ${length} bytes of randomness.`,
      );
    }

    return options.randomBytes;
  }

  const crypto = (globalThis as { crypto?: Crypto }).crypto;

  if (crypto === undefined) {
    throw new Error(
      "Web Crypto getRandomValues is required to generate bearer token secrets.",
    );
  }

  return crypto.getRandomValues(new Uint8Array(length));
}

/** @public */
export function generateBearerTokenSecret(
  options: GenerateBearerSecretOptions = {},
): string {
  const randomBytes = getBearerSecretRandomBytes(
    options,
    BEARER_TOKEN_SECRET_LENGTH,
  );
  let secret = "";

  for (let index = 0; index < BEARER_TOKEN_SECRET_LENGTH; index += 1) {
    secret += TOKEN_ID_ALPHABET[randomBytes[index] % TOKEN_ID_ALPHABET.length];
  }

  return secret;
}

/** @public */
export function formatPatBearerTokenString(
  tokenId: TokenId,
  secret: string,
): string {
  const tokenIdSuffix = tokenId.slice(ID_PREFIXES.token.length);

  return formatBearerTokenString({
    type: "pat",
    tokenIdSuffix,
    secret,
  });
}
