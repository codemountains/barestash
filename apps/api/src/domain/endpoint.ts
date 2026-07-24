import type { EndpointMetadata } from "@barestash/shared/endpoints";
import { assertEndpointId, type EndpointId } from "@barestash/shared/ids";
import { PRIVATE_ENDPOINT_EVENT_LIMIT } from "@barestash/shared/limits";

/** @public */
export type AccountId = string;
/** @public */
export const MVP_ACCOUNT_ID: AccountId = "acct_mvp";

/** @public */
export type StoredEndpoint = Omit<EndpointMetadata, "ingest_url"> & {
  account_id?: string | null;
};

/** @public */
export type CreateTemporaryEndpointInput = {
  id: EndpointId;
  name: string | null;
  now: Date;
};

/** @public */
export type CreatePrivateEndpointInput = {
  id: EndpointId;
  accountId: AccountId;
  name: string | null;
  now: Date;
};

/** @public */
export function isEndpointExpired(
  endpoint: StoredEndpoint,
  now: Date,
): boolean {
  return Date.parse(endpoint.expires_at) <= now.getTime();
}

/** @public */
export function endpointEventLimit(endpoint: StoredEndpoint): number | null {
  if (endpoint.mode !== "private") {
    return endpoint.event_limit;
  }

  return PRIVATE_ENDPOINT_EVENT_LIMIT;
}

export function deriveIngestOrigin(
  requestUrl: string,
  ingestHostname?: string,
): string {
  const url = new URL(requestUrl);

  if (ingestHostname !== undefined) {
    url.protocol = "https:";
    url.hostname = ingestHostname;
    url.port = "";
  } else if (url.hostname.startsWith("api.")) {
    url.hostname = `ingest.${url.hostname.slice("api.".length)}`;
  }

  return url.origin;
}

/** @public */
export function addIngestUrl(
  endpoint: StoredEndpoint,
  requestUrl: string,
  ingestHostname?: string,
): EndpointMetadata {
  const { account_id: _accountId, ...metadata } = endpoint;

  return {
    ...metadata,
    event_limit: endpointEventLimit(endpoint),
    ingest_url: `${deriveIngestOrigin(requestUrl, ingestHostname)}/${endpoint.id}`,
  };
}

/** @public */
export type EndpointRow = {
  id: string;
  account_id: string | null;
  name: string | null;
  mode: "private" | "temporary";
  status: "active" | "disabled" | "expired";
  public_read: number;
  event_count: number;
  event_limit: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

/** @public */
export function endpointRowToStoredEndpoint(row: EndpointRow): StoredEndpoint {
  return {
    id: assertEndpointId(row.id),
    account_id: row.account_id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    public_read: row.public_read === 1,
    event_count: row.event_count,
    event_limit: row.event_limit,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
