import type {
  RefreshTokenRequest,
  RefreshTokenResponse,
} from "@barestash/shared/auth";
import { createRestErrorResponse } from "@barestash/shared/errors";
import type { Context, Hono } from "hono";

import { authenticateBearerPrincipal } from "../../application/auth.js";
import {
  refreshCliSession,
  revokeCliSession,
} from "../../application/cli-session.js";
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
export function registerCliSessionRoutes(
  app: Hono<ApiEnv>,
  deps: AppDeps,
): void {
  app.post("/v1/auth/token/refresh", async (context) => {
    setNoStoreHeaders(context);
    const limited = await enforceHttpRateLimit(context, deps, {
      binding: "REFRESH_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "refresh",
    });
    if (limited !== null) return limited;
    const body = await readJsonObject(context);
    if (body instanceof Response) return body;
    if (
      body.grant_type !== "refresh_token" ||
      typeof body.refresh_token !== "string"
    ) {
      return context.json(
        createRestErrorResponse(
          "invalid_request",
          "grant_type and refresh_token are required.",
        ),
        400,
      );
    }
    const result = await refreshCliSession({
      repository: getAuthDomainRepository(context, deps),
      refreshToken: (body as RefreshTokenRequest).refresh_token,
      now: deps.getNow(),
      credentialPepper: getCredentialPepper(context),
      makeAccessTokenId: deps.makeAccessTokenId,
      makeRefreshTokenId: deps.makeRefreshTokenId,
      makeAccessToken: deps.makeAccessToken,
      makeRefreshToken: deps.makeRefreshToken,
    });
    if (result.kind === "error") return respondUseCaseError(context, result);
    return context.json(result.value satisfies RefreshTokenResponse, 200);
  });

  app.post("/v1/auth/sessions/current/revoke", async (context) => {
    setNoStoreHeaders(context);
    const repository = getAuthDomainRepository(context, deps);
    const authenticated = await authenticateBearerPrincipal(
      context.req.header("authorization") ?? null,
      repository,
      deps.getNow(),
      { pepper: getCredentialPepper(context) },
      false,
    );
    if (authenticated.kind === "error") {
      return respondUseCaseError(context, authenticated);
    }
    if (authenticated.value.credential.type !== "cli_access_token") {
      return context.json(
        createRestErrorResponse(
          "invalid_token",
          "A CLI access token is required.",
        ),
        401,
      );
    }
    const result = await revokeCliSession({
      repository,
      sessionId: authenticated.value.credential.sessionId,
      now: deps.getNow(),
    });
    if (result.kind === "error") return respondUseCaseError(context, result);
    return context.json(result.value, 200);
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
    // Returned below as a non-oracle request error.
  }
  return context.json(
    createRestErrorResponse(
      "invalid_request",
      "Request body must be a JSON object.",
    ),
    400,
  );
}
