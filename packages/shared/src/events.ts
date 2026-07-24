import type { HeaderMap, QueryParameters } from "./http.js";
import type { EndpointId, EventId } from "./ids.js";

/** @public */
export type EventBodyMetadata = {
  size: number;
  sha256: string;
  available: boolean;
  url?: string;
};

/** @public */
export type EventMetadata = {
  id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  method: string;
  request_path: string;
  query: QueryParameters;
  headers: HeaderMap;
  body: EventBodyMetadata;
};

/** @public */
export type EventDetail = {
  id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  request: {
    method: string;
    ingest_path: string;
    request_path: string;
    query: QueryParameters;
    headers: HeaderMap;
    body: EventBodyMetadata;
  };
};

/** @public */
export type EventListResponse = {
  events: EventMetadata[];
};

/** @public */
export type EventStreamPayload = {
  id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  request: {
    method: string;
    path: string;
    query: QueryParameters;
    headers: HeaderMap;
    body_size: number;
    body_sha256: string;
  };
  body: {
    encoding: "base64";
    data: string;
  };
};
