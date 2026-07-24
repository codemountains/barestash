import { createRestErrorResponse } from "@barestash/shared/errors";
import { assertEndpointId, isEndpointId } from "@barestash/shared/ids";
import type { Context, Hono } from "hono";

import { ingestRequest } from "../../application/ingest.js";
import { clientIpRateLimitKey } from "../../application/rate-limit.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getCredentialPepper,
  getEndpointRepository,
  getEndpointSecretRepository,
  getEventRepository,
  getRequestBodyStore,
  getStreamCoordinator,
} from "../../container.js";
import { enforceHttpRateLimit } from "../rate-limit.js";
import { respondUseCaseError } from "../response.js";

/** @public */
export function registerIngestRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const handleIngest = async (context: Context<ApiEnv>) => {
    const ipRateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "ABUSE_IP_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "ingest_ip",
    });

    if (ipRateLimited !== null) {
      return ipRateLimited;
    }

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

    const endpointRateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "INGEST_ENDPOINT_RATE_LIMITER",
      key: `endpoint:${endpointIdParam}`,
      surface: "ingest_endpoint",
      endpointId: endpointIdParam,
    });

    if (endpointRateLimited !== null) {
      return endpointRateLimited;
    }

    const result = await ingestRequest({
      endpointRepository: getEndpointRepository(context, deps),
      endpointSecretRepository: getEndpointSecretRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      requestBodyStore: getRequestBodyStore(context, deps),
      streamCoordinator: getStreamCoordinator(context, deps),
      getNow: deps.getNow,
      makeEventId: deps.makeEventId,
      endpointId: assertEndpointId(endpointIdParam),
      request: context.req.raw,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return new Response(null, {
      status: 204,
      headers: {
        "x-barestash-event-id": result.value.eventId,
        "x-barestash-endpoint-id": result.value.endpointId,
      },
    });
  };

  app.all("/:endpointId", handleIngest);
  app.all("/:endpointId/*", handleIngest);
}
