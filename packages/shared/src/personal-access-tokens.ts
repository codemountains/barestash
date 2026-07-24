import type { AuthorizationScope } from "./auth.js";
import type { TokenId } from "./ids.js";

/** @public */
export type PersonalAccessTokenStatus = "active" | "revoked" | "expired";

/** @public */
export type PersonalAccessTokenMetadata = {
  id: TokenId;
  name: string | null;
  status: PersonalAccessTokenStatus;
  scopes: AuthorizationScope[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export type PersonalAccessTokenCreateRequest = {
  name?: string;
  scopes: AuthorizationScope[];
  expires_in?: number | null;
};

/** @public */
export type PersonalAccessTokenCreateResponse = PersonalAccessTokenMetadata & {
  token: string;
};

/** @public */
export type PersonalAccessTokenReplayResponse = PersonalAccessTokenMetadata;

/** @public */
export type PersonalAccessTokenListResponse = {
  tokens: PersonalAccessTokenMetadata[];
};

/** @public */
export type PersonalAccessTokenRevokeResponse = {
  token: PersonalAccessTokenMetadata;
};
