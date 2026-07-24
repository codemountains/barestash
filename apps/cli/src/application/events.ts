import type {
  EventDetail,
  EventListResponse,
  EventMetadata,
} from "@barestash/shared/events";

import { transformBody } from "../domain/body.js";
import { type AuthDeps, authHeaders } from "./auth.js";
import { type CliResult, fromApiCall, ok } from "./result.js";

export type EventDeps = AuthDeps;

/** @public */
export async function listEvents(
  deps: EventDeps,
  endpointId: string,
  limit: number | undefined,
  extraQuery: Record<string, string> = {},
): Promise<CliResult<EventMetadata[]>> {
  const query = new URLSearchParams();

  if (limit !== undefined) {
    query.set("limit", String(limit));
  }

  for (const [name, value] of Object.entries(extraQuery)) {
    query.set(name, value);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const result = await deps.apiClient.request<EventListResponse>(
    `/v1/endpoints/${endpointId}/events${suffix}`,
    {
      headers: await authHeaders(deps),
    },
  );

  if (result.kind === "error") {
    return fromApiCall(result);
  }

  return ok(result.value.events);
}

/** @public */
export async function fetchEventDetail(
  deps: EventDeps,
  eventId: string,
): Promise<CliResult<EventDetail>> {
  const result = await deps.apiClient.request<EventDetail>(
    `/v1/events/${eventId}`,
    {
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

function eventContentType(event: EventMetadata | EventDetail): string {
  const headers = "request" in event ? event.request.headers : event.headers;

  return headers["content-type"] ?? "-";
}

/** @public */
export async function fetchEventBody(
  deps: EventDeps,
  event: EventDetail,
): Promise<CliResult<unknown>> {
  const response = await deps.apiClient.requestRaw(
    `/v1/events/${event.id}/body`,
    {
      headers: await authHeaders(deps),
    },
  );

  if (!response.ok) {
    return fromApiCall(await deps.apiClient.resultFromResponse(response));
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType =
    response.headers.get("content-type") ?? eventContentType(event);

  return ok(transformBody(bytes, contentType));
}

export type TailEventsResult =
  | { kind: "done"; exitCode: number }
  | Exclude<CliResult<void>, { kind: "ok" }>;

export type TailEventDeps = EventDeps & {
  sleeper: { sleep: (milliseconds: number) => Promise<void> };
  maxTailPolls?: number;
  onTailEvent: (event: EventMetadata) => Promise<number>;
};

/** @public */
export async function tailEvents(
  deps: TailEventDeps,
  endpointId: string,
  options: {
    last: number;
    pollInterval: number;
  },
): Promise<TailEventsResult> {
  let cursor: string | null = null;

  if (options.last > 0) {
    const initialResult = await listEvents(deps, endpointId, options.last);

    if (initialResult.kind !== "ok") {
      return initialResult;
    }

    for (const event of [...initialResult.value].reverse()) {
      const exitCode = await deps.onTailEvent(event);

      if (exitCode !== 0) {
        return { kind: "done", exitCode };
      }

      cursor = event.id;
    }
  } else {
    const latestResult = await listEvents(deps, endpointId, 1);

    if (latestResult.kind !== "ok") {
      return latestResult;
    }

    cursor = latestResult.value[0]?.id ?? null;
  }

  let polls = 0;

  while (deps.maxTailPolls === undefined || polls < deps.maxTailPolls) {
    if (polls > 0 || options.last > 0) {
      await deps.sleeper.sleep(options.pollInterval);
    }

    const requestedAfter = cursor;
    const eventsResult = await listEvents(
      deps,
      endpointId,
      undefined,
      requestedAfter === null ? {} : { after: requestedAfter },
    );

    if (eventsResult.kind !== "ok") {
      return eventsResult;
    }

    for (const event of requestedAfter === null
      ? [...eventsResult.value].reverse()
      : eventsResult.value) {
      const exitCode = await deps.onTailEvent(event);

      if (exitCode !== 0) {
        return { kind: "done", exitCode };
      }

      cursor = event.id;
    }

    polls += 1;
  }

  return { kind: "done", exitCode: 0 };
}

/** @public */
export async function showLatestEvent(
  deps: EventDeps,
  endpointId: string,
): Promise<CliResult<{ event: EventDetail | null; body: unknown | null }>> {
  const eventsResult = await listEvents(deps, endpointId, 1);

  if (eventsResult.kind !== "ok") {
    return eventsResult;
  }

  if (eventsResult.value.length === 0) {
    return ok({ event: null, body: null });
  }

  return showEvent(deps, eventsResult.value[0].id);
}

/** @public */
export async function showEvent(
  deps: EventDeps,
  eventId: string,
): Promise<CliResult<{ event: EventDetail; body: unknown }>> {
  const eventResult = await fetchEventDetail(deps, eventId);

  if (eventResult.kind !== "ok") {
    return eventResult;
  }

  const bodyResult = await fetchEventBody(deps, eventResult.value);

  if (bodyResult.kind !== "ok") {
    return bodyResult;
  }

  return ok({
    event: eventResult.value,
    body: bodyResult.value,
  });
}
