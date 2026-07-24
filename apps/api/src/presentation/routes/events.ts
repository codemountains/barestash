import { createRestErrorResponse } from "@barestash/shared/errors";
import {
  assertEndpointId,
  type EventId,
  isEndpointId,
  isEventId,
} from "@barestash/shared/ids";
import type { Hono } from "hono";
import { openEventStream } from "../../application/event-stream.js";
import {
  getEventBody,
  getEventDetail,
  listEvents,
} from "../../application/events.js";
import { clientIpRateLimitKey } from "../../application/rate-limit.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
  getEndpointRepository,
  getEventRepository,
  getRequestBodyStore,
  getStreamCoordinator,
} from "../../container.js";
import { enforceHttpRateLimit } from "../rate-limit.js";
import { getAuthorizationHeader } from "../request.js";
import { respondUseCaseError } from "../response.js";

/** @public */
export function registerEventRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.get("/v1/endpoints/:endpointId/events", async (context) => {
    const endpointIdParam = context.req.param("endpointId") ?? "";

    if (!isEndpointId(endpointIdParam)) {
      return context.json(
        createRestErrorResponse(
          "endpoint_not_found",
          `Endpoint not found: ${endpointIdParam}`,
        ),
        404,
      );
    }

    const searchParams = new URL(context.req.url).searchParams;

    const result = await listEvents({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      endpointId: assertEndpointId(endpointIdParam),
      afterParam: searchParams.get("after"),
      beforeParam: searchParams.get("before"),
      limitParam: searchParams.get("limit"),
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.get("/v1/events/:eventId", async (context) => {
    const eventIdParam = context.req.param("eventId") ?? "";

    if (!isEventId(eventIdParam)) {
      return context.json(
        createRestErrorResponse(
          "event_not_found",
          `Event not found: ${eventIdParam}`,
        ),
        404,
      );
    }

    const result = await getEventDetail({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      requestBodyStore: getRequestBodyStore(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      eventId: eventIdParam as EventId,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.get("/v1/events/:eventId/body", async (context) => {
    const eventIdParam = context.req.param("eventId") ?? "";

    if (!isEventId(eventIdParam)) {
      return context.json(
        createRestErrorResponse(
          "event_not_found",
          `Event not found: ${eventIdParam}`,
        ),
        404,
      );
    }

    const result = await getEventBody({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      requestBodyStore: getRequestBodyStore(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      eventId: eventIdParam as EventId,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return new Response(result.value.bodyBytes, {
      headers:
        result.value.contentType === null
          ? undefined
          : { "content-type": result.value.contentType },
    });
  });
}

/** @public */
export function registerEventStreamRoutes(
  app: Hono<ApiEnv>,
  deps: AppDeps,
): void {
  app.get("/v1/endpoints/:endpointId/events/stream", async (context) => {
    const endpointIdParam = context.req.param("endpointId") ?? "";

    if (!isEndpointId(endpointIdParam)) {
      return context.json(
        createRestErrorResponse(
          "endpoint_not_found",
          `Endpoint not found: ${endpointIdParam}`,
        ),
        404,
      );
    }

    const rateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "SSE_RATE_LIMITER",
      key: `endpoint:${endpointIdParam}:actor:${clientIpRateLimitKey(context.req.raw)}`,
      surface: "sse",
      endpointId: endpointIdParam,
    });

    if (rateLimited !== null) {
      return rateLimited;
    }

    const lastEventIdHeader = context.req.raw.headers.get("last-event-id");

    const result = await openEventStream({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      requestBodyStore: getRequestBodyStore(context, deps),
      streamCoordinator: getStreamCoordinator(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      endpointId: assertEndpointId(endpointIdParam),
      lastEventIdHeader,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return new Response(result.value.subscription.stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
}
