import { createRestErrorResponse } from "@barestash/shared/errors";
import { assertStoredTokenId, isStoredTokenId } from "@barestash/shared/ids";
import type {
  PersonalAccessTokenCreateRequest,
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
  PersonalAccessTokenReplayResponse,
  PersonalAccessTokenRevokeResponse,
} from "@barestash/shared/personal-access-tokens";
import type { Context, Hono } from "hono";

import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from "../../application/tokens.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
} from "../../container.js";
import {
  enforcePatWriteRateLimits,
  getWriteAuthentication,
} from "../rate-limit.js";
import {
  getAuthorizationHeader,
  InvalidJsonRequestError,
  InvalidRequestBodyError,
  readCreateTokenRequest,
} from "../request.js";
import { respondUseCaseError } from "../response.js";

/** @public */
export function registerTokenRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.post("/v1/tokens", async (context) => {
    setNoStoreHeaders(context);
    const rateLimited = await enforcePatWriteRateLimits(context, deps);

    if (rateLimited !== null) return rateLimited;

    let body: PersonalAccessTokenCreateRequest;

    try {
      body = await readCreateTokenRequest(context.req.raw);
    } catch (error) {
      if (error instanceof InvalidJsonRequestError) {
        return noStoreJson(
          context,
          createRestErrorResponse(
            "invalid_request",
            "Request body must be valid JSON.",
          ),
          400,
        );
      }

      if (error instanceof InvalidRequestBodyError) {
        return noStoreJson(
          context,
          createRestErrorResponse("invalid_request", error.message),
          400,
        );
      }

      throw error;
    }

    const result = await createPersonalAccessToken({
      repository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authentication: getWriteAuthentication(context),
      makeTokenId: deps.makeTokenId,
      makeTokenSecret: deps.makeTokenSecret,
      makePatIdempotencyId: deps.makePatIdempotencyId,
      idempotencyKey: context.req.header("idempotency-key") ?? null,
      credentialPepper: getCredentialPepper(context),
      body,
    });

    if (result.kind === "error") {
      setNoStoreHeaders(context);
      return respondUseCaseError(context, result);
    }

    return noStoreJson(
      context,
      result.value.token satisfies
        | PersonalAccessTokenCreateResponse
        | PersonalAccessTokenReplayResponse,
      result.value.replayed ? 200 : 201,
    );
  });

  app.get("/v1/tokens", async (context) => {
    setNoStoreHeaders(context);
    const result = await listPersonalAccessTokens({
      repository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      includeInactive:
        new URL(context.req.url).searchParams.get("all") === "true",
      credentialPepper: getCredentialPepper(context),
    });

    if (result.kind === "error") {
      setNoStoreHeaders(context);
      return respondUseCaseError(context, result);
    }

    return noStoreJson(
      context,
      result.value satisfies PersonalAccessTokenListResponse,
      200,
    );
  });

  app.delete("/v1/tokens/:tokenId", async (context) => {
    setNoStoreHeaders(context);
    const rateLimited = await enforcePatWriteRateLimits(context, deps);
    if (rateLimited !== null) return rateLimited;

    const tokenIdParam = context.req.param("tokenId") ?? "";

    if (!isStoredTokenId(tokenIdParam)) {
      return noStoreJson(
        context,
        createRestErrorResponse(
          "not_authorized",
          `Token not found: ${tokenIdParam}`,
        ),
        404,
      );
    }

    const result = await revokePersonalAccessToken({
      repository: getAuthDomainRepository(context, deps),
      now: deps.getNow(),
      authentication: getWriteAuthentication(context),
      tokenId: assertStoredTokenId(tokenIdParam),
    });

    if (result.kind === "error") {
      setNoStoreHeaders(context);
      return respondUseCaseError(context, result);
    }

    return noStoreJson(
      context,
      result.value satisfies PersonalAccessTokenRevokeResponse,
      200,
    );
  });
}

export function setNoStoreHeaders(context: {
  header(name: string, value: string): void;
}): void {
  context.header("Cache-Control", "no-store");
  context.header("Pragma", "no-cache");
}

function noStoreJson(
  context: Context<ApiEnv>,
  body: unknown,
  status: 200 | 201 | 400 | 404,
) {
  setNoStoreHeaders(context);
  return context.json(body, status);
}
