export const CREDENTIAL_HASH_ALGORITHM = "hmac-sha256";
export const CREDENTIAL_HASH_BYTES = 32;

// HMAC requires a non-empty key. Empty pepper is only permitted in
// application tests composed by createTestApiApp; production requests fail
// closed without BARESTASH_CREDENTIAL_PEPPER via app middleware.
const EMPTY_PEPPER_HMAC_KEY = "barestash-empty-pepper-dev-only";

type CredentialKeyCache = {
  keyMaterial: string;
  keyPromise: Promise<CryptoKey>;
};

let credentialKeyCache: CredentialKeyCache | undefined;

export type CredentialHashOptions = {
  pepper?: string;
};

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return mismatch === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function getCredentialKey(keyMaterial: string): Promise<CryptoKey> {
  if (credentialKeyCache?.keyMaterial === keyMaterial) {
    return credentialKeyCache.keyPromise;
  }

  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const cacheEntry = { keyMaterial, keyPromise };
  credentialKeyCache = cacheEntry;

  void keyPromise.catch(() => {
    if (credentialKeyCache === cacheEntry) {
      credentialKeyCache = undefined;
    }
  });

  return keyPromise;
}

async function deriveCredentialHash(
  secret: string,
  options: CredentialHashOptions = {},
): Promise<Uint8Array> {
  const pepper = options.pepper ?? "";
  const keyMaterial = pepper === "" ? EMPTY_PEPPER_HMAC_KEY : pepper;
  const key = await getCredentialKey(keyMaterial);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(secret),
  );

  return new Uint8Array(signature);
}

function parseStoredCredentialHash(storedHash: string): Uint8Array | null {
  const parts = storedHash.split("$");

  if (parts.length !== 2) {
    return null;
  }

  const [algorithm, hashHex] = parts;

  if (algorithm !== CREDENTIAL_HASH_ALGORITHM) {
    return null;
  }

  const hash = hexToBytes(hashHex ?? "");

  if (hash === null || hash.length !== CREDENTIAL_HASH_BYTES) {
    return null;
  }

  return hash;
}

/** @public */
export async function hashCredential(
  secret: string,
  options: CredentialHashOptions = {},
): Promise<string> {
  const derived = await deriveCredentialHash(secret, options);

  return `${CREDENTIAL_HASH_ALGORITHM}$${bytesToHex(derived)}`;
}

export async function verifyCredential(
  secret: string,
  storedHash: string,
  options: CredentialHashOptions = {},
): Promise<boolean> {
  const parsed = parseStoredCredentialHash(storedHash);

  if (parsed === null) {
    return false;
  }

  const derived = await deriveCredentialHash(secret, options);

  return timingSafeEqual(derived, parsed);
}
