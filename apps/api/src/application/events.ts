import type { EventDetail, EventMetadata } from "@barestash/shared/events";
import {
  type EndpointId,
  type EventId,
  isEventId,
} from "@barestash/shared/ids";
import type { AuthDomainRepository } from "../domain/auth-domain.js";
import {
  type EventListRecord,
  type EventMetadataInsert,
  eventDetailFromInsert,
  eventListLimit,
  eventMetadataFromListRecord,
  type RequestEnvelope,
} from "../domain/event.js";
import type {
  EndpointRepository,
  EventRepository,
  RequestBodyStore,
} from "../domain/ports.js";
import type { CredentialPepperDeps } from "./auth.js";
import { resolveReadableEndpoint } from "./endpoints.js";
import { err, ok, type UseCaseResult } from "./result.js";

export type ListEventsDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  eventRepository: EventRepository;
  now: Date;
  authorizationHeader: string | null;
  endpointId: EndpointId;
  afterParam: string | null;
  beforeParam: string | null;
  limitParam: string | null;
};

/** @public */
export async function listEvents(
  deps: ListEventsDeps,
): Promise<UseCaseResult<{ events: EventMetadata[] }>> {
  const readableEndpoint = await resolveReadableEndpoint({
    endpointRepository: deps.endpointRepository,
    tokenRepository: deps.tokenRepository,
    now: deps.now,
    authorizationHeader: deps.authorizationHeader,
    endpointId: deps.endpointId,
    credentialPepper: deps.credentialPepper,
  });

  if (readableEndpoint.kind === "error") {
    return readableEndpoint;
  }

  if (deps.afterParam !== null && !isEventId(deps.afterParam)) {
    return err("invalid_request", "Invalid after cursor.", 400);
  }

  if (deps.beforeParam !== null && !isEventId(deps.beforeParam)) {
    return err("invalid_request", "Invalid before cursor.", 400);
  }

  const readOptions = {
    limit: eventListLimit(deps.limitParam),
    ...(deps.afterParam === null ? {} : { after: deps.afterParam }),
    ...(deps.beforeParam === null ? {} : { before: deps.beforeParam }),
  };

  let events: EventListRecord[];

  try {
    events = await deps.eventRepository.listEventsForEndpoint(
      deps.endpointId,
      readOptions,
    );
  } catch {
    return err("internal_error", "Failed to read event metadata.", 500);
  }

  return ok({
    events: events.map(eventMetadataFromListRecord),
  });
}

export type GetEventDetailDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  eventRepository: EventRepository;
  requestBodyStore: RequestBodyStore;
  now: Date;
  authorizationHeader: string | null;
  eventId: EventId;
};

/** @public */
export async function getEventDetail(
  deps: GetEventDetailDeps,
): Promise<UseCaseResult<EventDetail>> {
  let event: EventMetadataInsert | null;

  try {
    event = await deps.eventRepository.findEvent(deps.eventId);
  } catch {
    return err("internal_error", "Failed to read event metadata.", 500);
  }

  if (event === null) {
    return err("event_not_found", `Event not found: ${deps.eventId}`, 404);
  }

  const readableEndpoint = await resolveReadableEndpoint({
    endpointRepository: deps.endpointRepository,
    tokenRepository: deps.tokenRepository,
    now: deps.now,
    authorizationHeader: deps.authorizationHeader,
    endpointId: event.endpoint_id,
    credentialPepper: deps.credentialPepper,
  });

  if (readableEndpoint.kind === "error") {
    return readableEndpoint;
  }

  let envelopeBytes: Uint8Array | null;

  try {
    envelopeBytes = await deps.requestBodyStore.get(event.request_r2_key);
  } catch {
    return err("internal_error", "Failed to read event request envelope.", 500);
  }

  if (envelopeBytes === null) {
    return err(
      "body_not_found",
      `Event request envelope not found: ${deps.eventId}`,
      404,
    );
  }

  let envelope: RequestEnvelope;

  try {
    envelope = JSON.parse(
      new TextDecoder().decode(envelopeBytes),
    ) as RequestEnvelope;
  } catch {
    return err("internal_error", "Failed to read event request envelope.", 500);
  }

  return ok(eventDetailFromInsert(event, envelope));
}

export type GetEventBodyDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  eventRepository: EventRepository;
  requestBodyStore: RequestBodyStore;
  now: Date;
  authorizationHeader: string | null;
  eventId: EventId;
};

export type EventBodyResult = {
  bodyBytes: Uint8Array;
  contentType: string | null;
  size: number;
  sha256: string;
};

/** @public */
export async function getEventBody(
  deps: GetEventBodyDeps,
): Promise<UseCaseResult<EventBodyResult>> {
  let event: EventMetadataInsert | null;

  try {
    event = await deps.eventRepository.findEvent(deps.eventId);
  } catch {
    return err("internal_error", "Failed to read event metadata.", 500);
  }

  if (event === null) {
    return err("event_not_found", `Event not found: ${deps.eventId}`, 404);
  }

  const readableEndpoint = await resolveReadableEndpoint({
    endpointRepository: deps.endpointRepository,
    tokenRepository: deps.tokenRepository,
    now: deps.now,
    authorizationHeader: deps.authorizationHeader,
    endpointId: event.endpoint_id,
    credentialPepper: deps.credentialPepper,
  });

  if (readableEndpoint.kind === "error") {
    return readableEndpoint;
  }

  let bodyBytes: Uint8Array | null;

  try {
    bodyBytes = await deps.requestBodyStore.get(event.body_r2_key);
  } catch {
    return err("internal_error", "Failed to read event body.", 500);
  }

  if (bodyBytes === null) {
    return err("body_not_found", `Event body not found: ${deps.eventId}`, 404);
  }

  return ok({
    bodyBytes,
    contentType: event.content_type,
    size: event.body_size,
    sha256: event.body_sha256,
  });
}
