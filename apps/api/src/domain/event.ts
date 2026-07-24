import type {
  EventDetail,
  EventMetadata,
  EventStreamPayload,
} from "@barestash/shared/events";
import { redactHeadersForDisplay } from "@barestash/shared/headers";
import type { HeaderMap, QueryParameters } from "@barestash/shared/http";
import {
  assertEndpointId,
  type EndpointId,
  type EventId,
} from "@barestash/shared/ids";

import type { RequestBodyStore } from "./ports.js";

export type SecretVerificationStatus = "not_configured" | "matched";

/** @public */
export const MAX_BODY_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EVENT_LIST_LIMIT = 20;
/** @public */
export const MAX_EVENT_LIST_LIMIT = 100;

/** @public */
export type EventMetadataInsert = {
  id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  method: string;
  ingest_path: string;
  request_path: string;
  query_json: string;
  allowlist_headers_json: string;
  sensitive_header_names_json: string;
  content_type: string | null;
  content_length: number | null;
  user_agent: string | null;
  body_size: number;
  body_sha256: string;
  body_r2_key: string;
  request_r2_key: string;
  secret_verification_status: SecretVerificationStatus;
  matched_secret_id: string | null;
  created_at: string;
};

/** @public */
export type EventListRecord = {
  id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  method: string;
  request_path: string;
  query_json: string;
  allowlist_headers_json: string;
  body_size: number;
  body_sha256: string;
  body_r2_key: string;
  request_r2_key: string;
};

/** @public */
export type RequestEnvelope = {
  event_id: EventId;
  endpoint_id: EndpointId;
  received_at: string;
  method: string;
  ingest_path: string;
  request_path: string;
  query: QueryParameters;
  headers: HeaderMap;
  body: {
    r2_key: string;
    size: number;
    sha256: string;
  };
};

/** @public */
export type EventRow = {
  sequence: number;
  id: string;
  endpoint_id: string;
  received_at: string;
  method: string;
  ingest_path: string;
  request_path: string;
  query_json: string;
  allowlist_headers_json: string;
  sensitive_header_names_json: string;
  content_type: string | null;
  content_length: number | null;
  user_agent: string | null;
  body_size: number;
  body_sha256: string;
  body_r2_key: string;
  request_r2_key: string;
  secret_verification_status: SecretVerificationStatus;
  matched_secret_id: string | null;
  created_at: string;
};

/** @public */
export type EventListRow = {
  id: string;
  endpoint_id: string;
  received_at: string;
  method: string;
  request_path: string;
  query_json: string;
  allowlist_headers_json: string;
  body_size: number;
  body_sha256: string;
  body_r2_key: string;
  request_r2_key: string;
};

export class EventBodyNotFoundError extends Error {}
export class EventEnvelopeNotFoundError extends Error {}
export class EventEnvelopeParseError extends Error {}
/** @public */
export class PayloadTooLargeError extends Error {}

function parseJsonObject<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value) as unknown;

    return typeof parsed === "object" && parsed !== null
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

/** @public */
export function eventRowToMetadataInsert(row: EventRow): EventMetadataInsert {
  return {
    id: row.id as EventId,
    endpoint_id: assertEndpointId(row.endpoint_id),
    received_at: row.received_at,
    method: row.method,
    ingest_path: row.ingest_path,
    request_path: row.request_path,
    query_json: row.query_json,
    allowlist_headers_json: row.allowlist_headers_json,
    sensitive_header_names_json: row.sensitive_header_names_json,
    content_type: row.content_type,
    content_length: row.content_length,
    user_agent: row.user_agent,
    body_size: row.body_size,
    body_sha256: row.body_sha256,
    body_r2_key: row.body_r2_key,
    request_r2_key: row.request_r2_key,
    secret_verification_status: row.secret_verification_status,
    matched_secret_id: row.matched_secret_id,
    created_at: row.created_at,
  };
}

/** @public */
export function eventListRowToRecord(row: EventListRow): EventListRecord {
  return {
    id: row.id as EventId,
    endpoint_id: assertEndpointId(row.endpoint_id),
    received_at: row.received_at,
    method: row.method,
    request_path: row.request_path,
    query_json: row.query_json,
    allowlist_headers_json: row.allowlist_headers_json,
    body_size: row.body_size,
    body_sha256: row.body_sha256,
    body_r2_key: row.body_r2_key,
    request_r2_key: row.request_r2_key,
  };
}

/** @public */
export function eventMetadataFromListRecord(
  event: EventListRecord,
): EventMetadata {
  return {
    id: event.id,
    endpoint_id: event.endpoint_id,
    received_at: event.received_at,
    method: event.method,
    request_path: event.request_path,
    query: parseJsonObject<QueryParameters>(event.query_json, {}),
    headers: parseJsonObject<HeaderMap>(event.allowlist_headers_json, {}),
    body: {
      size: event.body_size,
      sha256: event.body_sha256,
      available: true,
    },
  };
}

/** @public */
export function eventDetailFromInsert(
  event: EventMetadataInsert,
  envelope: RequestEnvelope,
): EventDetail {
  return {
    id: event.id,
    endpoint_id: event.endpoint_id,
    received_at: event.received_at,
    request: {
      method: event.method,
      ingest_path: event.ingest_path,
      request_path: event.request_path,
      query: envelope.query,
      headers: redactHeadersForDisplay(envelope.headers),
      body: {
        size: event.body_size,
        sha256: event.body_sha256,
        available: true,
        url: `/v1/events/${event.id}/body`,
      },
    },
  };
}

/** @public */
export function eventStreamPayloadFromParts(
  event: EventListRecord,
  envelope: RequestEnvelope,
  bodyBytes: Uint8Array,
): EventStreamPayload {
  return {
    id: event.id,
    endpoint_id: event.endpoint_id,
    received_at: event.received_at,
    request: {
      method: event.method,
      path: envelope.request_path,
      query: envelope.query,
      headers: redactHeadersForDisplay(envelope.headers),
      body_size: event.body_size,
      body_sha256: event.body_sha256,
    },
    body: {
      encoding: "base64",
      data: base64Encode(bodyBytes),
    },
  };
}

/** @public */
export async function eventStreamPayloadFromStoredEvent(
  event: EventListRecord,
  requestBodyStore: RequestBodyStore,
): Promise<EventStreamPayload> {
  const [bodyBytes, envelopeBytes] = await Promise.all([
    requestBodyStore.get(event.body_r2_key),
    requestBodyStore.get(event.request_r2_key),
  ]);

  if (bodyBytes === null) {
    throw new EventBodyNotFoundError();
  }

  if (envelopeBytes === null) {
    throw new EventEnvelopeNotFoundError();
  }

  let envelope: RequestEnvelope;

  try {
    envelope = JSON.parse(
      new TextDecoder().decode(envelopeBytes),
    ) as RequestEnvelope;
  } catch {
    throw new EventEnvelopeParseError();
  }

  return eventStreamPayloadFromParts(event, envelope, bodyBytes);
}

function datePathParts(date: Date): {
  year: string;
  month: string;
  day: string;
} {
  return {
    year: String(date.getUTCFullYear()).padStart(4, "0"),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
}

/** @public */
export function createEventObjectKeys(
  endpointId: EndpointId,
  eventId: EventId,
  receivedAt: Date,
): { bodyR2Key: string; requestR2Key: string } {
  const { year, month, day } = datePathParts(receivedAt);
  const prefix = `events/${endpointId}/${year}/${month}/${day}/${eventId}`;

  return {
    bodyR2Key: `${prefix}/body.raw`,
    requestR2Key: `${prefix}/request.json`,
  };
}

/** @public */
export function eventListLimit(value: string | null): number {
  if (value === null) {
    return DEFAULT_EVENT_LIST_LIMIT;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_EVENT_LIST_LIMIT;
  }

  return Math.min(parsed, MAX_EVENT_LIST_LIMIT);
}
