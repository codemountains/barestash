import type { EndpointId } from "./ids.js";

/** @public */
export type EndpointMode = "private" | "temporary";

/** @public */
export type EndpointStatus = "active" | "disabled" | "expired";

/** @public */
export type EndpointMetadata = {
  id: EndpointId;
  name: string | null;
  mode: EndpointMode;
  status: EndpointStatus;
  public_read: boolean;
  event_count: number;
  event_limit: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  ingest_url: string;
};

/** @public */
export type EndpointResponse = {
  endpoint: EndpointMetadata;
};

/** @public */
export type EndpointListResponse = {
  endpoints: EndpointMetadata[];
};

/** @public */
export type CreateEndpointRequest = {
  mode?: EndpointMode;
  name?: string;
};

/** @public */
export type EndpointDeleteResponse = {
  endpoint: EndpointMetadata;
  deleted_events: number;
  deleted_body_objects: number;
};
