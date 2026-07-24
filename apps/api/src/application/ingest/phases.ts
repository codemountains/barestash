import {
  BARESTASH_SECRET_HEADER,
  filterPersistedHeaders,
  filterRawRequestHeaders,
  isSensitiveHeader,
} from "@barestash/shared/headers";
import type { HeaderMap, QueryParameters } from "@barestash/shared/http";
import type { EndpointId, EventId, SecretId } from "@barestash/shared/ids";

import {
  endpointEventLimit,
  isEndpointExpired,
  type StoredEndpoint,
} from "../../domain/endpoint.js";
import {
  createEventObjectKeys,
  type EventMetadataInsert,
  eventStreamPayloadFromParts,
  MAX_BODY_SIZE_BYTES,
  PayloadTooLargeError,
  type RequestEnvelope,
} from "../../domain/event.js";
import type { EndpointSecretRepository } from "../../domain/ports.js";
import { sha256Hex } from "../auth.js";
import { verifyCredential } from "../credential-hash.js";
import { err, type UseCaseError } from "../result.js";
import type { CompensationStack } from "./compensation.js";
import type { IngestDeps } from "./types.js";

type SecretVerification = {
  status: "not_configured" | "matched";
  matchedSecretId: SecretId | null;
};

export type PersistedRequest = {
  eventId: EventId;
  receivedAtIso: string;
  bodyBytes: Uint8Array;
  bodySha256: string;
  bodyR2Key: string;
  requestR2Key: string;
  requestEnvelope: RequestEnvelope;
  ingestPath: string;
  requestPath: string;
  query: QueryParameters;
  headers: HeaderMap;
  allowlistHeaders: HeaderMap;
  contentLength: number | null;
};

export class IngestPhaseError extends Error {
  readonly result: UseCaseError;

  constructor(result: UseCaseError) {
    super(result.message);
    this.name = "IngestPhaseError";
    this.result = result;
  }
}

function fail(...args: Parameters<typeof err>): never {
  throw new IngestPhaseError(err(...args));
}

function numberHeader(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function headersToRecord(headers: Headers): HeaderMap {
  const record: HeaderMap = {};

  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value;
  });

  return record;
}

function queryParameters(searchParams: URLSearchParams): QueryParameters {
  const query: QueryParameters = {};

  for (const [name, value] of searchParams) {
    const existing = query[name];

    if (existing === undefined) {
      query[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[name] = [existing, value];
    }
  }

  return query;
}

function requestPathForEndpoint(
  ingestPath: string,
  endpointId: EndpointId,
): string {
  const endpointPrefix = `/${endpointId}`;
  const requestPath = ingestPath.slice(endpointPrefix.length);

  return requestPath.length === 0 ? "/" : requestPath;
}

function sensitiveHeaderNamesForD1(headers: HeaderMap): string[] {
  return Object.keys(filterRawRequestHeaders(headers))
    .filter((name) => isSensitiveHeader(name))
    .sort();
}

async function readRequestBodyBytes(request: Request): Promise<Uint8Array> {
  const contentLength = numberHeader(request.headers.get("content-length"));

  if (contentLength !== null && contentLength > MAX_BODY_SIZE_BYTES) {
    throw new PayloadTooLargeError();
  }

  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > MAX_BODY_SIZE_BYTES) {
      throw new PayloadTooLargeError();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export async function validateEndpoint(
  deps: IngestDeps,
): Promise<StoredEndpoint> {
  let endpoint: StoredEndpoint | null;

  try {
    endpoint = await deps.endpointRepository.findEndpoint(deps.endpointId);
  } catch {
    fail("internal_error", "Failed to read endpoint metadata.", 500);
  }

  if (endpoint === null || endpoint.status === "disabled") {
    fail("endpoint_not_found", `Endpoint not found: ${deps.endpointId}`, 404);
  }

  if (
    endpoint.status === "expired" ||
    isEndpointExpired(endpoint, deps.getNow())
  ) {
    fail("endpoint_expired", `Endpoint expired: ${deps.endpointId}`, 410);
  }

  return endpoint;
}

export async function reserveCapacity(
  deps: IngestDeps,
  endpoint: StoredEndpoint,
  compensations: CompensationStack,
): Promise<void> {
  const eventLimit = endpointEventLimit(endpoint);

  if (endpoint.mode === "temporary" && eventLimit !== null) {
    let reserved: boolean;

    try {
      reserved = await deps.endpointRepository.reserveTemporaryEventSlot(
        deps.endpointId,
        eventLimit,
      );
    } catch {
      fail("internal_error", "Failed to reserve event capacity.", 500);
    }

    if (!reserved) {
      fail(
        "event_limit_exceeded",
        `Endpoint has reached the ${eventLimit}-event limit.`,
        429,
      );
    }

    compensations.add(() =>
      deps.endpointRepository.releaseTemporaryEventSlot(deps.endpointId),
    );
    return;
  }

  if (endpoint.mode !== "private") {
    return;
  }

  let reserved: boolean;

  try {
    reserved =
      eventLimit === null
        ? await deps.endpointRepository.incrementPrivateEndpointEventCount(
            deps.endpointId,
          )
        : await deps.endpointRepository.reservePrivateEventSlot(
            deps.endpointId,
            eventLimit,
            deps.getNow(),
          );
  } catch {
    fail("internal_error", "Failed to update endpoint event count.", 500);
  }

  if (!reserved) {
    if (eventLimit === null) {
      fail("internal_error", "Failed to update endpoint event count.", 500);
    }

    const latestEndpoint = await validateEndpoint(deps);
    const latestEventLimit = endpointEventLimit(latestEndpoint);

    if (
      latestEndpoint.mode === "private" &&
      latestEventLimit !== null &&
      latestEndpoint.event_count >= latestEventLimit
    ) {
      fail(
        "event_limit_exceeded",
        `Endpoint has reached the ${latestEventLimit}-event limit.`,
        429,
      );
    }

    fail("internal_error", "Failed to update endpoint event count.", 500);
  }

  compensations.add(() =>
    deps.endpointRepository.releasePrivateEndpointEventCount(deps.endpointId),
  );
}

export async function verifySecret(
  deps: IngestDeps,
  endpoint: StoredEndpoint,
): Promise<SecretVerification> {
  if (endpoint.mode !== "private") {
    return { status: "not_configured", matchedSecretId: null };
  }

  let activeSecrets: Awaited<
    ReturnType<EndpointSecretRepository["listActiveEndpointSecrets"]>
  >;

  try {
    activeSecrets =
      await deps.endpointSecretRepository.listActiveEndpointSecrets(
        deps.endpointId,
      );
  } catch {
    fail("internal_error", "Failed to read endpoint secrets.", 500);
  }

  if (activeSecrets.length === 0) {
    return { status: "not_configured", matchedSecretId: null };
  }

  const providedSecret = deps.request.headers.get(BARESTASH_SECRET_HEADER);

  if (providedSecret === null || providedSecret.length === 0) {
    fail(
      "missing_ingest_secret",
      "Webhook rejected: missing x-barestash-secret.",
      401,
    );
  }

  let matchedSecretId: SecretId | null = null;

  // Intentionally verify every active candidate so request timing does not
  // disclose which rotation secret matched through an early exit.
  for (const secret of activeSecrets) {
    const matches = await verifyCredential(providedSecret, secret.secret_hash, {
      pepper: deps.credentialPepper ?? "",
    });

    if (matches) {
      matchedSecretId = secret.id;
    }
  }

  if (matchedSecretId === null) {
    fail(
      "invalid_ingest_secret",
      "Webhook rejected: invalid x-barestash-secret.",
      401,
    );
  }

  try {
    await deps.endpointSecretRepository.updateEndpointSecretLastUsed(
      matchedSecretId,
      deps.getNow().toISOString(),
    );
  } catch {
    fail(
      "d1_write_failed",
      "Failed to update endpoint secret last-used metadata.",
      500,
    );
  }

  return { status: "matched", matchedSecretId };
}

export async function persistRawRequest(
  deps: IngestDeps,
  compensations: CompensationStack,
): Promise<PersistedRequest> {
  let bodyBytes: Uint8Array;

  try {
    bodyBytes = await readRequestBodyBytes(deps.request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      fail("payload_too_large", "Request body exceeds the 10MB limit.", 413);
    }

    fail("internal_error", "Failed to read request body.", 500);
  }

  const eventId = deps.makeEventId();
  const receivedAt = deps.getNow();
  const receivedAtIso = receivedAt.toISOString();
  const requestUrl = new URL(deps.request.url);
  const ingestPath = requestUrl.pathname;
  const requestPath = requestPathForEndpoint(ingestPath, deps.endpointId);
  const query = queryParameters(requestUrl.searchParams);
  const headers = headersToRecord(deps.request.headers);
  const allowlistHeaders = filterPersistedHeaders(headers);
  const rawRequestHeaders = filterRawRequestHeaders(headers);
  const bodySha256 = await sha256Hex(bodyBytes);
  const { bodyR2Key, requestR2Key } = createEventObjectKeys(
    deps.endpointId,
    eventId,
    receivedAt,
  );
  const requestEnvelope = {
    event_id: eventId,
    endpoint_id: deps.endpointId,
    received_at: receivedAtIso,
    method: deps.request.method,
    ingest_path: ingestPath,
    request_path: requestPath,
    query,
    headers: rawRequestHeaders,
    body: {
      r2_key: bodyR2Key,
      size: bodyBytes.byteLength,
      sha256: bodySha256,
    },
  } satisfies RequestEnvelope;

  const persistObject = async (
    key: string,
    value: Uint8Array | string,
  ): Promise<boolean> => {
    try {
      await deps.requestBodyStore.put(key, value);
      compensations.add(() => deps.requestBodyStore.delete(key));
      return true;
    } catch {
      return false;
    }
  };
  const writesSucceeded = await Promise.all([
    persistObject(bodyR2Key, bodyBytes),
    persistObject(requestR2Key, JSON.stringify(requestEnvelope)),
  ]);

  if (writesSucceeded.includes(false)) {
    fail("r2_write_failed", "Failed to store request body.", 500);
  }

  return {
    eventId,
    receivedAtIso,
    bodyBytes,
    bodySha256,
    bodyR2Key,
    requestR2Key,
    requestEnvelope,
    ingestPath,
    requestPath,
    query,
    headers,
    allowlistHeaders,
    contentLength: numberHeader(headers["content-length"] ?? null),
  };
}

export async function recordMetadata(
  deps: IngestDeps,
  endpoint: StoredEndpoint,
  request: PersistedRequest,
  secretVerification: SecretVerification,
): Promise<EventMetadataInsert> {
  if (isEndpointExpired(endpoint, deps.getNow())) {
    fail("endpoint_expired", `Endpoint expired: ${deps.endpointId}`, 410);
  }

  const eventInsert = {
    id: request.eventId,
    endpoint_id: deps.endpointId,
    received_at: request.receivedAtIso,
    method: deps.request.method,
    ingest_path: request.ingestPath,
    request_path: request.requestPath,
    query_json: JSON.stringify(request.query),
    allowlist_headers_json: JSON.stringify(request.allowlistHeaders),
    sensitive_header_names_json: JSON.stringify(
      sensitiveHeaderNamesForD1(request.headers),
    ),
    content_type: request.allowlistHeaders["content-type"] ?? null,
    content_length: request.contentLength,
    user_agent: request.allowlistHeaders["user-agent"] ?? null,
    body_size: request.bodyBytes.byteLength,
    body_sha256: request.bodySha256,
    body_r2_key: request.bodyR2Key,
    request_r2_key: request.requestR2Key,
    secret_verification_status: secretVerification.status,
    matched_secret_id: secretVerification.matchedSecretId,
    created_at: request.receivedAtIso,
  } satisfies EventMetadataInsert;

  let created: Awaited<
    ReturnType<IngestDeps["eventRepository"]["createEvent"]>
  >;

  try {
    created = await deps.eventRepository.createEvent(eventInsert);
  } catch {
    fail("d1_write_failed", "Failed to store event metadata.", 500);
  }

  switch (created.status) {
    case "created":
      return eventInsert;
    case "matched_secret_inactive":
      return fail(
        "invalid_ingest_secret",
        "Webhook rejected: invalid x-barestash-secret.",
        401,
      );
    case "active_secret_required":
      return fail(
        "missing_ingest_secret",
        "Webhook rejected: missing x-barestash-secret.",
        401,
      );
    case "endpoint_inactive":
      return fail(
        "endpoint_not_found",
        `Endpoint not found: ${deps.endpointId}`,
        404,
      );
  }
}

export async function publishLive(
  deps: IngestDeps,
  eventMetadata: EventMetadataInsert,
  request: PersistedRequest,
): Promise<void> {
  const presence = await deps.streamCoordinator
    .getSubscriberPresence(deps.endpointId)
    .catch(() => null);

  if (presence?.hasSubscribers === false) {
    return;
  }

  const streamPayload = eventStreamPayloadFromParts(
    eventMetadata,
    request.requestEnvelope,
    request.bodyBytes,
  );

  const publish =
    presence === null
      ? deps.streamCoordinator.publish(deps.endpointId, streamPayload)
      : deps.streamCoordinator.publish(deps.endpointId, streamPayload, {
          maxSubscriberSequence: presence.maxSubscriberSequence,
        });

  await publish.catch(() => {});
}
