import {
  type EndpointId,
  type EventId,
  isEventId,
} from "@barestash/shared/ids";
import type { AuthDomainRepository } from "../domain/auth-domain.js";
import {
  eventStreamPayloadFromStoredEvent,
  MAX_BODY_SIZE_BYTES,
  MAX_EVENT_LIST_LIMIT,
} from "../domain/event.js";
import type {
  EndpointRepository,
  EventRepository,
  EventStreamCoordinator,
  EventStreamSubscription,
  RequestBodyStore,
} from "../domain/ports.js";
import type { CredentialPepperDeps } from "./auth.js";
import { resolveReadableEndpoint } from "./endpoints.js";
import { err, ok, type UseCaseResult } from "./result.js";

export const MAX_AUTHENTICATED_EVENT_STREAM_DURATION_MILLISECONDS =
  60 * 60 * 1000;

// Each event loads its body and envelope concurrently. Keep no more than six
// R2 reads active and cap raw body bytes whose encoded payloads may coexist.
const MAX_CONCURRENT_CATCH_UP_R2_READS = 6;
const R2_READS_PER_CATCH_UP_EVENT = 2;
const MAX_CONCURRENT_CATCH_UP_EVENTS =
  MAX_CONCURRENT_CATCH_UP_R2_READS / R2_READS_PER_CATCH_UP_EVENT;
const MAX_IN_FLIGHT_CATCH_UP_BODY_BYTES = 2 * MAX_BODY_SIZE_BYTES;

export type OpenEventStreamDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  eventRepository: EventRepository;
  requestBodyStore: RequestBodyStore;
  streamCoordinator: EventStreamCoordinator;
  now: Date;
  authorizationHeader: string | null;
  endpointId: EndpointId;
  lastEventIdHeader: string | null;
};

export type OpenEventStreamResult = {
  subscription: EventStreamSubscription;
};

async function sendCatchUpEvents(
  events: Awaited<ReturnType<EventRepository["listEventsForEndpoint"]>>,
  requestBodyStore: RequestBodyStore,
  subscription: EventStreamSubscription,
): Promise<void> {
  type PayloadResult =
    | {
        kind: "success";
        payload: Awaited<ReturnType<typeof eventStreamPayloadFromStoredEvent>>;
      }
    | { kind: "error"; error: unknown };
  type PendingPayload = {
    bodySize: number;
    result: Promise<PayloadResult>;
  };

  const pendingPayloads = new Map<number, PendingPayload>();
  let nextIndexToStart = 0;
  let inFlightBodyBytes = 0;
  let signalFailure: (
    result: Extract<PayloadResult, { kind: "error" }>,
  ) => void;
  const failure = new Promise<Extract<PayloadResult, { kind: "error" }>>(
    (resolve) => {
      signalFailure = resolve;
    },
  );

  const startPendingPayloads = () => {
    while (
      pendingPayloads.size < MAX_CONCURRENT_CATCH_UP_EVENTS &&
      nextIndexToStart < events.length
    ) {
      const event = events[nextIndexToStart];
      const bodySize = Math.max(event.body_size, 0);

      if (
        pendingPayloads.size > 0 &&
        inFlightBodyBytes + bodySize > MAX_IN_FLIGHT_CATCH_UP_BODY_BYTES
      ) {
        break;
      }

      const result = eventStreamPayloadFromStoredEvent(
        event,
        requestBodyStore,
      ).then<PayloadResult, PayloadResult>(
        (payload) => ({ kind: "success", payload }),
        (error: unknown) => {
          const failed = { kind: "error", error } as const;
          signalFailure(failed);
          return failed;
        },
      );
      pendingPayloads.set(nextIndexToStart, { bodySize, result });
      inFlightBodyBytes += bodySize;
      nextIndexToStart += 1;
    }
  };

  startPendingPayloads();

  for (let index = 0; index < events.length; index += 1) {
    const pending = pendingPayloads.get(index);

    if (pending === undefined) {
      throw new Error("Catch-up payload scheduling failed.");
    }

    const result = await Promise.race([pending.result, failure]);

    if (result.kind === "error") {
      throw result.error;
    }

    pendingPayloads.delete(index);
    inFlightBodyBytes -= pending.bodySize;
    subscription.send(result.payload);
    startPendingPayloads();
  }
}

/** @public */
export async function openEventStream(
  deps: OpenEventStreamDeps,
): Promise<UseCaseResult<OpenEventStreamResult>> {
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

  if (deps.lastEventIdHeader !== null && !isEventId(deps.lastEventIdHeader)) {
    return err("invalid_request", "Invalid Last-Event-ID cursor.", 400);
  }

  const lastEventId = deps.lastEventIdHeader as EventId | null;

  let subscription: EventStreamSubscription;

  try {
    subscription = await deps.streamCoordinator.subscribe(deps.endpointId, {
      bufferPublishedEvents: lastEventId !== null,
      ...(readableEndpoint.value.mode === "private"
        ? {
            maxDurationMilliseconds:
              MAX_AUTHENTICATED_EVENT_STREAM_DURATION_MILLISECONDS,
          }
        : {}),
    });
  } catch {
    return err("internal_error", "Failed to open event stream.", 500);
  }

  if (lastEventId !== null) {
    void (async () => {
      try {
        const catchUpEvents = await deps.eventRepository.listEventsForEndpoint(
          deps.endpointId,
          {
            limit: MAX_EVENT_LIST_LIMIT,
            after: lastEventId,
          },
        );

        await sendCatchUpEvents(
          catchUpEvents,
          deps.requestBodyStore,
          subscription,
        );

        subscription.flushBuffered();
      } catch {
        await subscription.cancel();
      }
    })();
  }

  return ok({ subscription });
}
