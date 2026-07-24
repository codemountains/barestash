import type { EndpointId, SecretId } from "./ids.js";

/** @public */
export type EndpointSecretStatus = "active" | "revoked";

/** @public */
export type EndpointSecretMetadata = {
  id: SecretId;
  endpoint_id: EndpointId;
  status: EndpointSecretStatus;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export type EndpointSecretCreateResponse = {
  endpoint_secret: EndpointSecretMetadata;
  secret: string;
};

/** @public */
export type EndpointSecretListResponse = {
  endpoint_secrets: EndpointSecretMetadata[];
};

/** @public */
export type EndpointSecretRevokeResponse = {
  endpoint_secret: EndpointSecretMetadata;
};
