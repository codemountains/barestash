import type { AccessTokenId, AccountId, CliSessionId, TokenId } from "./ids.js";

/** @public */
export const AUTHORIZATION_SCOPES = [
  "endpoints:read",
  "endpoints:write",
  "events:read",
  "tokens:read",
  "tokens:write",
  "mcp:use",
] as const;

/** @public */
export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];

/** @public */
export type AccountStatus = "active" | "disabled";

/** @public */
export type DeviceAuthorizationStatus =
  | "pending"
  | "approved"
  | "denied"
  | "consumed"
  | "expired";

/** @public */
export type CliSessionStatus = "active" | "revoked" | "compromised" | "expired";

/** @public */
export type AccessTokenStatus = "active" | "revoked" | "expired";

/** @public */
export type RefreshTokenStatus = "active" | "used" | "revoked" | "expired";

/** @public */
export type CliAccessCredentialMetadata = {
  type: "cli_access_token";
  id: AccessTokenId;
  sessionId: CliSessionId;
  scopes: AuthorizationScope[];
  expiresAt: string;
};

/** @public */
export type PersonalAccessCredentialMetadata = {
  type: "personal_access_token";
  id: TokenId;
  scopes: AuthorizationScope[];
  expiresAt: string | null;
};

/** @public */
export type CredentialMetadata =
  | CliAccessCredentialMetadata
  | PersonalAccessCredentialMetadata;

/** @public */
export type AuthPrincipal = {
  accountId: AccountId;
  credential: CredentialMetadata;
};

/** @public */
export type DeviceAuthorizationCreateRequest = {
  client_name: string;
  client_version?: string;
  device_name?: string;
  requested_scopes: AuthorizationScope[];
};

/** @public */
export type DeviceAuthorizationCreateResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/** @public */
export type DeviceTokenRequest = { device_code: string };

/** @public */
export type DeviceTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token_expires_in: number;
  scopes: AuthorizationScope[];
};

/** @public */
export type RefreshTokenRequest = {
  grant_type: "refresh_token";
  refresh_token: string;
};

/** @public */
export type RefreshTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token_expires_in: number;
};

/** @public */
export type AccountResponse = {
  account: {
    id: AccountId;
    primary_email: string | null;
  };
  credential:
    | {
        type: "cli_access_token";
        id: AccessTokenId;
        session_id: CliSessionId;
        scopes: AuthorizationScope[];
        expires_at: string;
      }
    | {
        type: "personal_access_token";
        id: TokenId;
        scopes: AuthorizationScope[];
        expires_at: string | null;
      };
};

/** @public */
export type CliSessionRevokeResponse = {
  session: {
    id: CliSessionId;
    status: CliSessionStatus;
    revoked_at: string;
  };
};
