/** @public */
export class InvalidApiBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiBaseUrlError";
  }
}

export type ValidateApiBaseUrlOptions = {
  allowInsecure?: boolean;
};

export type ValidateApiBaseUrlResult =
  | { ok: true; url: URL }
  | { ok: false; message: string };

const PRIVATE_OR_LINK_LOCAL_MESSAGE =
  "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.";

const REDIRECT_PRIVATE_OR_LINK_LOCAL_MESSAGE =
  "Redirect target points to a private or link-local address.";

export function validateApiBaseUrl(
  rawUrl: string,
  options: ValidateApiBaseUrlOptions = {},
): ValidateApiBaseUrlResult {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      message: "BARESTASH_API_URL is not a valid URL.",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: "BARESTASH_API_URL must use the http: or https: scheme.",
    };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      message: "BARESTASH_API_URL must not include embedded credentials.",
    };
  }

  if (!options.allowInsecure && isPrivateOrLinkLocalHost(url.hostname)) {
    return {
      ok: false,
      message: PRIVATE_OR_LINK_LOCAL_MESSAGE,
    };
  }

  return { ok: true, url };
}

/** @public */
export function resolveApiBaseUrl(
  rawUrl: string,
  options: ValidateApiBaseUrlOptions = {},
): string {
  const result = validateApiBaseUrl(rawUrl, options);

  if (!result.ok) {
    throw new InvalidApiBaseUrlError(result.message);
  }

  return result.url.toString();
}

export function validateRedirectTarget(
  rawUrl: string,
  options: ValidateApiBaseUrlOptions = {},
): void {
  const result = validateApiBaseUrl(rawUrl, options);

  if (!result.ok) {
    if (
      !options.allowInsecure &&
      result.message === PRIVATE_OR_LINK_LOCAL_MESSAGE
    ) {
      throw new Error(REDIRECT_PRIVATE_OR_LINK_LOCAL_MESSAGE);
    }

    throw new Error(result.message);
  }
}

function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (normalized === "localhost") {
    return false;
  }

  const ipv4 = parseIPv4(normalized);

  if (ipv4 !== null) {
    return isPrivateOrLinkLocalIPv4(ipv4);
  }

  const ipv6 = parseIPv6(normalized);

  if (ipv6 !== null) {
    return isPrivateOrLinkLocalIPv6(ipv6);
  }

  if (normalized === "metadata.google.internal") {
    return true;
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();

  if (lower.endsWith(".")) {
    return lower.slice(0, -1);
  }

  return lower;
}

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const value = Number(part);

    if (value < 0 || value > 255) {
      return null;
    }

    octets.push(value);
  }

  return octets;
}

function isPrivateOrLinkLocalIPv4(octets: number[]): boolean {
  const [first, second] = octets;

  if (first === 127) {
    return false;
  }

  if (first === 10) {
    return true;
  }

  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }

  if (first === 192 && second === 168) {
    return true;
  }

  if (first === 169 && second === 254) {
    return true;
  }

  if (first === 0) {
    return true;
  }

  return false;
}

function parseIPv6(hostname: string): string | null {
  if (!hostname.includes(":")) {
    return null;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1).toLowerCase();
  }

  return hostname.toLowerCase();
}

function isPrivateOrLinkLocalIPv6(hostname: string): boolean {
  if (hostname === "::1") {
    return false;
  }

  if (isIpv6LinkLocal(hostname)) {
    return true;
  }

  if (
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fec0:")
  ) {
    return true;
  }

  const mappedIpv4 = parseIpv4MappedIpv6(hostname);

  if (mappedIpv4 !== null) {
    return isPrivateOrLinkLocalIPv4(mappedIpv4);
  }

  return false;
}

function isIpv6LinkLocal(hostname: string): boolean {
  const firstHextet = hostname.split(":")[0];

  if (firstHextet.length === 0) {
    return false;
  }

  const value = Number.parseInt(firstHextet, 16);

  if (Number.isNaN(value)) {
    return false;
  }

  return (value & 0xffc0) === 0xfe80;
}

function parseIpv4MappedIpv6(hostname: string): number[] | null {
  const dottedPrefix = "::ffff:";

  if (hostname.startsWith(dottedPrefix)) {
    const mappedIpv4 = parseIPv4(hostname.slice(dottedPrefix.length));

    if (mappedIpv4 !== null) {
      return mappedIpv4;
    }
  }

  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);

  if (hexMatch === null) {
    return null;
  }

  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/** @public */
export function formatApiHost(url: string): string {
  return new URL(url).hostname;
}
