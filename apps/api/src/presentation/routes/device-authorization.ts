import type {
  DeviceAuthorizationCreateRequest,
  DeviceAuthorizationCreateResponse,
  DeviceTokenRequest,
  DeviceTokenResponse,
} from "@barestash/shared/auth";
import { createRestErrorResponse } from "@barestash/shared/errors";
import type { Context, Hono } from "hono";

import {
  createDeviceAuthorization,
  pollDeviceAuthorizationToken,
} from "../../application/device-authorization.js";
import { clientIpRateLimitKey } from "../../application/rate-limit.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
} from "../../container.js";
import { enforceHttpRateLimit } from "../rate-limit.js";
import { respondUseCaseError } from "../response.js";
import { setNoStoreHeaders } from "./tokens.js";

/** @public */
export function registerDeviceAuthorizationRoutes(
  app: Hono<ApiEnv>,
  deps: AppDeps,
): void {
  app.post("/v1/auth/device/authorizations", async (context) => {
    setNoStoreHeaders(context);
    const appOrigin = context.env?.BARESTASH_APP_ORIGIN;
    if (appOrigin === undefined) {
      return noStoreJson(
        context,
        createRestErrorResponse(
          "device_authorization_unavailable",
          "Device Authorization is not available.",
        ),
        503,
      );
    }
    const limited = await enforceHttpRateLimit(context, deps, {
      binding: "DEVICE_CREATION_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "device_creation",
    });
    if (limited !== null) return limited;

    const body = await readJsonObject(context);
    if (body instanceof Response) return body;
    const result = await createDeviceAuthorization({
      repository: getAuthDomainRepository(context, deps),
      body: body as DeviceAuthorizationCreateRequest,
      now: deps.getNow(),
      credentialPepper: getCredentialPepper(context),
      verificationUri: new URL("/device", appOrigin).toString(),
      makeDeviceAuthorizationId: deps.makeDeviceAuthorizationId,
      makeDeviceCode: deps.makeDeviceCode,
      makeUserCode: deps.makeUserCode,
    });
    if (result.kind === "error") return respondUseCaseError(context, result);
    return noStoreJson(
      context,
      result.value satisfies DeviceAuthorizationCreateResponse,
      201,
    );
  });

  app.post("/v1/auth/device/token", async (context) => {
    setNoStoreHeaders(context);
    const limited = await enforceHttpRateLimit(context, deps, {
      binding: "DEVICE_POLL_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "device_poll",
    });
    if (limited !== null) return limited;

    const body = await readJsonObject(context);
    if (body instanceof Response) return body;
    if (typeof body.device_code !== "string") {
      return noStoreJson(
        context,
        createRestErrorResponse("invalid_request", "device_code is required."),
        400,
      );
    }
    const result = await pollDeviceAuthorizationToken({
      repository: getAuthDomainRepository(context, deps),
      deviceCode: (body as DeviceTokenRequest).device_code,
      now: deps.getNow(),
      credentialPepper: getCredentialPepper(context),
      makeCliSessionId: deps.makeCliSessionId,
      makeAccessTokenId: deps.makeAccessTokenId,
      makeRefreshTokenId: deps.makeRefreshTokenId,
      makeAccessToken: deps.makeAccessToken,
      makeRefreshToken: deps.makeRefreshToken,
    });
    if (result.kind === "error") return respondUseCaseError(context, result);
    return noStoreJson(
      context,
      result.value satisfies DeviceTokenResponse,
      200,
    );
  });
}

async function readJsonObject(
  context: Context<ApiEnv>,
): Promise<Record<string, unknown> | Response> {
  try {
    const body: unknown = await context.req.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Returned below as the same non-oracle request error.
  }
  return noStoreJson(
    context,
    createRestErrorResponse(
      "invalid_request",
      "Request body must be a JSON object.",
    ),
    400,
  );
}

function noStoreJson(
  context: Context<ApiEnv>,
  body: unknown,
  status: 200 | 201 | 400 | 503,
) {
  setNoStoreHeaders(context);
  return context.json(body, status);
}
