import type {
  EndpointSecretMetadata,
  EndpointSecretStatus,
} from "@barestash/shared/endpoint-secrets";
import {
  assertEndpointId,
  assertSecretId,
  type EndpointId,
  type SecretId,
} from "@barestash/shared/ids";

/** @public */
export type CreateEndpointSecretInput = {
  id: SecretId;
  endpointId: EndpointId;
  secretHash: string;
  now: Date;
};

/** @public */
export type StoredEndpointSecret = EndpointSecretMetadata & {
  secret_hash: string;
};

/** @public */
export type EndpointSecretRow = {
  id: string;
  endpoint_id: string;
  secret_hash: string;
  status: EndpointSecretStatus;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** @public */
export function endpointSecretToMetadata(
  secret: StoredEndpointSecret,
): EndpointSecretMetadata {
  return {
    id: secret.id,
    endpoint_id: secret.endpoint_id,
    status: secret.status,
    created_at: secret.created_at,
    last_used_at: secret.last_used_at,
    revoked_at: secret.revoked_at,
  };
}

/** @public */
export function endpointSecretRowToStoredSecret(
  row: EndpointSecretRow,
): StoredEndpointSecret {
  return {
    id: assertSecretId(row.id),
    endpoint_id: assertEndpointId(row.endpoint_id),
    secret_hash: row.secret_hash,
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

/** @public */
export function generateEndpointSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let secret = "";

  for (const byte of bytes) {
    secret += byte.toString(16).padStart(2, "0");
  }

  return secret;
}
