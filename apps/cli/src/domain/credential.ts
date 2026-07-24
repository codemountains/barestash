import type { AuthorizationScope } from "@barestash/shared/auth";

/** @public */
export type StoredCredential =
  | {
      type: "personal_access_token";
      token: string;
    }
  | {
      type: "cli_session";
      session_id: string;
      access_token: string;
      refresh_token: string;
      access_token_expires_at: string;
      refresh_token_expires_at: string;
      scopes: AuthorizationScope[];
    };

/** @public */
export function parseStoredCredential(
  value: string | null,
): StoredCredential | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCredential>;
    if (
      parsed.type === "personal_access_token" &&
      typeof parsed.token === "string"
    ) {
      return { type: parsed.type, token: parsed.token };
    }
    if (
      parsed.type === "cli_session" &&
      typeof parsed.session_id === "string" &&
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string" &&
      typeof parsed.access_token_expires_at === "string" &&
      typeof parsed.refresh_token_expires_at === "string" &&
      Array.isArray(parsed.scopes)
    ) {
      return parsed as StoredCredential;
    }
  } catch {
    // Invalid credential storage is treated as empty without exposing contents.
  }
  return null;
}
