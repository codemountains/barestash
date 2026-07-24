import type { EventStreamPayload } from "@barestash/shared/events";

import { transformStreamPayload } from "../domain/body.js";
import {
  consumeEventStream,
  EventStreamConnectionError,
} from "../infrastructure/sse.js";
import { type AuthDeps, authHeaders } from "./auth.js";
import {
  CliApiErrorException,
  type CliResult,
  fromApiCall,
  ok,
} from "./result.js";

export const STREAM_RECONNECT_DELAY_MS = 1000;

export type StreamEventsDeps = AuthDeps & {
  signal?: AbortSignal;
  sleeper: { sleep: (milliseconds: number) => Promise<void> };
  maxStreamReconnects?: number;
  onPayload: (payload: unknown) => void;
};

/** @public */
export async function streamEvents(
  deps: StreamEventsDeps,
  endpointId: string,
): Promise<CliResult<void>> {
  const maxReconnects = deps.maxStreamReconnects ?? Number.POSITIVE_INFINITY;
  let reconnects = 0;
  let lastEventId: string | null = null;

  while (true) {
    let response: Response;

    try {
      response = await deps.apiClient.requestRaw(
        `/v1/endpoints/${endpointId}/events/stream`,
        {
          headers: {
            accept: "text/event-stream",
            ...(await authHeaders(deps)),
            ...(lastEventId === null ? {} : { "last-event-id": lastEventId }),
          },
        },
      );
    } catch (error) {
      if (deps.signal?.aborted === true) {
        throw deps.signal.reason;
      }

      if (error instanceof CliApiErrorException) {
        throw error;
      }

      if (reconnects >= maxReconnects) {
        throw error;
      }

      reconnects += 1;
      await deps.sleeper.sleep(STREAM_RECONNECT_DELAY_MS);
      continue;
    }

    if (!response.ok) {
      return fromApiCall(await deps.apiClient.resultFromResponse(response));
    }

    try {
      lastEventId = await consumeEventStream(
        response,
        (payload: EventStreamPayload) => {
          deps.onPayload(transformStreamPayload(payload));
        },
        lastEventId,
        deps.signal,
      );
    } catch (error) {
      if (deps.signal?.aborted === true) {
        throw deps.signal.reason;
      }

      if (
        !(error instanceof EventStreamConnectionError) ||
        reconnects >= maxReconnects
      ) {
        throw error;
      }

      lastEventId = error.lastEventId;
      reconnects += 1;
      await deps.sleeper.sleep(STREAM_RECONNECT_DELAY_MS);
      continue;
    }

    if (reconnects >= maxReconnects) {
      return ok(undefined);
    }

    reconnects += 1;
    await deps.sleeper.sleep(STREAM_RECONNECT_DELAY_MS);
  }
}
