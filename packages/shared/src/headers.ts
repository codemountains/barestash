import type { HeaderMap } from "./http.js";

/** @public */
export const BARESTASH_SECRET_HEADER = "x-barestash-secret";

/** @public */
export const BARESTASH_BOOTSTRAP_TOKEN_HEADER = "x-barestash-bootstrap-token";

/** @public */
export const REDACTED_HEADER_VALUE = "[REDACTED]";

/** @public */
export const PERSISTED_HEADER_NAMES = [
  "content-type",
  "content-length",
  "user-agent",
  "x-request-id",
  "x-correlation-id",
  "x-github-event",
  "x-gitlab-event",
  "x-shopify-topic",
] as const;

/** @public */
export const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  BARESTASH_SECRET_HEADER,
  BARESTASH_BOOTSTRAP_TOKEN_HEADER,
  "stripe-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-slack-signature",
  "x-shopify-hmac-sha256",
] as const;

/** @public */
export type PersistedHeaderName = (typeof PERSISTED_HEADER_NAMES)[number];

/** @public */
export type SensitiveHeaderName = (typeof SENSITIVE_HEADER_NAMES)[number];

const PERSISTED_HEADER_SET = new Set<string>(PERSISTED_HEADER_NAMES);
const SENSITIVE_HEADER_SET = new Set<string>(SENSITIVE_HEADER_NAMES);

function normalizeHeaderName(name: string): string {
  return name.toLowerCase();
}

function normalizeHeaders(headers: HeaderMap): HeaderMap {
  const normalized: HeaderMap = {};

  for (const [name, value] of Object.entries(headers)) {
    normalized[normalizeHeaderName(name)] = value;
  }

  return normalized;
}

/** @public */
export function isPersistedHeader(name: string): name is PersistedHeaderName {
  return PERSISTED_HEADER_SET.has(normalizeHeaderName(name));
}

/** @public */
export function isSensitiveHeader(name: string): name is SensitiveHeaderName {
  return SENSITIVE_HEADER_SET.has(normalizeHeaderName(name));
}

/** @public */
export function filterPersistedHeaders(headers: HeaderMap): HeaderMap {
  const persistedHeaders: HeaderMap = {};

  for (const [name, value] of Object.entries(normalizeHeaders(headers))) {
    if (isPersistedHeader(name)) {
      persistedHeaders[name] = value;
    }
  }

  return persistedHeaders;
}

/** @public */
export function filterRawRequestHeaders(headers: HeaderMap): HeaderMap {
  const rawHeaders: HeaderMap = {};

  for (const [name, value] of Object.entries(normalizeHeaders(headers))) {
    if (
      name !== BARESTASH_SECRET_HEADER &&
      name !== BARESTASH_BOOTSTRAP_TOKEN_HEADER
    ) {
      rawHeaders[name] = value;
    }
  }

  return rawHeaders;
}

/** @public */
export function redactHeadersForDisplay(headers: HeaderMap): HeaderMap {
  const displayHeaders: HeaderMap = {};

  for (const [name, value] of Object.entries(
    filterRawRequestHeaders(headers),
  )) {
    displayHeaders[name] = isSensitiveHeader(name)
      ? REDACTED_HEADER_VALUE
      : value;
  }

  return displayHeaders;
}
