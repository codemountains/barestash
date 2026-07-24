import type {
  CreateEndpointRequest,
  EndpointResponse,
} from "@barestash/shared/endpoints";
import { createRestErrorResponse } from "@barestash/shared/errors";
import {
  assertEndpointId,
  assertSecretId,
  isEndpointId,
  isSecretId,
} from "@barestash/shared/ids";
import type { Hono } from "hono";
import {
  createEndpoint,
  createEndpointSecret,
  deleteEndpoint,
  listEndpointSecrets,
  listEndpoints,
  revokeEndpointSecret,
  showEndpoint,
} from "../../application/endpoints.js";
import { clientIpRateLimitKey } from "../../application/rate-limit.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
  getEndpointRepository,
  getEndpointSecretRepository,
  getEventRepository,
  getRequestBodyStore,
} from "../../container.js";
import {
  enforceHttpRateLimit,
  enforceWriteRateLimits,
  getWriteAuthentication,
} from "../rate-limit.js";
import {
  getAuthorizationHeader,
  InvalidJsonRequestError,
  InvalidRequestBodyError,
  readCreateEndpointRequest,
} from "../request.js";
import { respondUseCaseError } from "../response.js";

/** @public */
export function registerEndpointRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.post("/v1/endpoints", async (context) => {
    const rateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "ENDPOINT_CREATION_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "endpoint_creation",
    });

    if (rateLimited !== null) {
      return rateLimited;
    }

    let body: CreateEndpointRequest;

    try {
      body = await readCreateEndpointRequest(context.req.raw);
    } catch (error) {
      if (error instanceof InvalidJsonRequestError) {
        return context.json(
          createRestErrorResponse(
            "invalid_request",
            "Request body must be valid JSON.",
          ),
          400,
        );
      }

      if (error instanceof InvalidRequestBodyError) {
        return context.json(
          createRestErrorResponse("invalid_request", error.message),
          400,
        );
      }

      throw error;
    }

    const result = await createEndpoint({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      makeEndpointId: deps.makeEndpointId,
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      requestUrl: context.req.url,
      ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
      body,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value satisfies EndpointResponse, 201);
  });

  app.get("/v1/endpoints", async (context) => {
    const result = await listEndpoints({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      requestUrl: context.req.url,
      ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.get("/v1/endpoints/:endpointId", async (context) => {
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

    const result = await showEndpoint({
      endpointRepository: getEndpointRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      requestUrl: context.req.url,
      ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
      endpointId: assertEndpointId(endpointIdParam),
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.delete("/v1/endpoints/:endpointId", async (context) => {
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

    const rateLimited = await enforceWriteRateLimits(
      context,
      deps,
      endpointIdParam,
    );

    if (rateLimited !== null) {
      return rateLimited;
    }

    const result = await deleteEndpoint({
      endpointRepository: getEndpointRepository(context, deps),
      endpointSecretRepository: getEndpointSecretRepository(context, deps),
      eventRepository: getEventRepository(context, deps),
      requestBodyStore: getRequestBodyStore(context, deps),
      authentication: getWriteAuthentication(context),
      now: deps.getNow(),
      requestUrl: context.req.url,
      ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
      endpointId: assertEndpointId(endpointIdParam),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.post("/v1/endpoints/:endpointId/secrets", async (context) => {
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

    const rateLimited = await enforceWriteRateLimits(
      context,
      deps,
      endpointIdParam,
    );

    if (rateLimited !== null) {
      return rateLimited;
    }

    const result = await createEndpointSecret({
      endpointRepository: getEndpointRepository(context, deps),
      endpointSecretRepository: getEndpointSecretRepository(context, deps),
      authentication: getWriteAuthentication(context),
      now: deps.getNow(),
      endpointId: assertEndpointId(endpointIdParam),
      makeSecretId: deps.makeSecretId,
      makeEndpointSecret: deps.makeEndpointSecret,
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value, 201);
  });

  app.get("/v1/endpoints/:endpointId/secrets", async (context) => {
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

    const result = await listEndpointSecrets({
      endpointRepository: getEndpointRepository(context, deps),
      endpointSecretRepository: getEndpointSecretRepository(context, deps),
      tokenRepository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      endpointId: assertEndpointId(endpointIdParam),
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });

  app.delete("/v1/endpoints/:endpointId/secrets/:secretId", async (context) => {
    const endpointIdParam = context.req.param("endpointId") ?? "";
    const secretIdParam = context.req.param("secretId") ?? "";

    if (!isEndpointId(endpointIdParam)) {
      return context.json(
        createRestErrorResponse(
          "endpoint_not_found",
          `Endpoint not found: ${endpointIdParam}`,
        ),
        404,
      );
    }

    if (!isSecretId(secretIdParam)) {
      return context.json(
        createRestErrorResponse(
          "endpoint_not_found",
          `Endpoint secret not found: ${secretIdParam}`,
        ),
        404,
      );
    }

    const rateLimited = await enforceWriteRateLimits(
      context,
      deps,
      endpointIdParam,
    );

    if (rateLimited !== null) {
      return rateLimited;
    }

    const result = await revokeEndpointSecret({
      endpointRepository: getEndpointRepository(context, deps),
      endpointSecretRepository: getEndpointSecretRepository(context, deps),
      authentication: getWriteAuthentication(context),
      now: deps.getNow(),
      endpointId: assertEndpointId(endpointIdParam),
      secretId: assertSecretId(secretIdParam),
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      return respondUseCaseError(context, result);
    }

    return context.json(result.value);
  });
}
