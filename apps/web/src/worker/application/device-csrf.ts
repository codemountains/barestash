type DeviceCsrfClaims = {
  session_id: string;
  authorization_id: string;
  expires_at: string;
};

type CreateDeviceCsrfInput = {
  secret: string;
  sessionId: string;
  authorizationId: string;
  expiresAt: string;
};

type VerifyDeviceCsrfInput = {
  secret: string;
  sessionId: string;
  authorizationId: string;
  now: Date;
};

/** @public */
export async function createDeviceCsrfToken(
  input: CreateDeviceCsrfInput,
): Promise<string> {
  const payload = encodeText(
    JSON.stringify({
      session_id: input.sessionId,
      authorization_id: input.authorizationId,
      expires_at: input.expiresAt,
    } satisfies DeviceCsrfClaims),
  );
  return `${payload}.${encodeBytes(await sign(payload, input.secret))}`;
}

/** @public */
export async function verifyDeviceCsrfToken(
  token: string,
  input: VerifyDeviceCsrfInput,
): Promise<boolean> {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) {
    return false;
  }

  let claims: DeviceCsrfClaims;
  try {
    claims = JSON.parse(decodeText(payload)) as DeviceCsrfClaims;
  } catch {
    return false;
  }
  if (
    claims.session_id !== input.sessionId ||
    claims.authorization_id !== input.authorizationId ||
    typeof claims.expires_at !== "string" ||
    Date.parse(claims.expires_at) <= input.now.getTime()
  ) {
    return false;
  }

  const expected = encodeBytes(await sign(payload, input.secret));
  return timingSafeEqual(signature, expected);
}

async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
}

function encodeText(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
