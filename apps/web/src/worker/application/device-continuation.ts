type ContinuationClaims = {
  authorization_id: string;
  user_code: string;
  expires_at: string;
};

type CreateContinuationInput = {
  secret: string;
  authorizationId: string;
  userCode: string;
  expiresAt: string;
  randomBytes?: Uint8Array;
};

export type DeviceContinuation = {
  authorizationId: string;
  userCode: string;
  expiresAt: string;
};

/** @public */
export async function createDeviceContinuation(
  input: CreateContinuationInput,
): Promise<string> {
  const iv = input.randomBytes ?? crypto.getRandomValues(new Uint8Array(12));
  if (iv.length !== 12) {
    throw new TypeError(
      "Device continuation encryption requires a 12-byte IV.",
    );
  }
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      authorization_id: input.authorizationId,
      user_code: input.userCode,
      expires_at: input.expiresAt,
    } satisfies ContinuationClaims),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await continuationKey(input.secret),
      plaintext,
    ),
  );
  return `v1.${encodeBytes(iv)}.${encodeBytes(ciphertext)}`;
}

/** @public */
export async function readDeviceContinuation(
  token: string,
  input: { secret: string; now: Date },
): Promise<DeviceContinuation | null> {
  const [version, encodedIv, encodedCiphertext, extra] = token.split(".");
  if (
    version !== "v1" ||
    encodedIv === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    return null;
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBytes(encodedIv) },
      await continuationKey(input.secret),
      decodeBytes(encodedCiphertext),
    );
    const claims = JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as ContinuationClaims;
    if (
      typeof claims.authorization_id !== "string" ||
      typeof claims.user_code !== "string" ||
      typeof claims.expires_at !== "string" ||
      Date.parse(claims.expires_at) <= input.now.getTime()
    ) {
      return null;
    }
    return {
      authorizationId: claims.authorization_id,
      userCode: claims.user_code,
      expiresAt: claims.expires_at,
    };
  } catch {
    return null;
  }
}

async function continuationKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`barestash-device-continuation:${secret}`),
  );
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
