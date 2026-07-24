import type { Context } from "hono";

import {
  authenticateResourcePrincipal,
  type PrincipalAuthenticationResult,
  recordPrincipalLastUsed,
} from "../application/auth.js";
import {
  checkRateLimit,
  clientIpRateLimitKey,
  type RateLimitSurface,
} from "../application/rate-limit.js";
import type { ApiEnv, AppDeps, RateLimitBindingName } from "../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
  getRateLimiter,
} from "../container.js";
import { getAuthorizationHeader } from "./request.js";
import { respondRateLimitError } from "./response.js";

export async function checkContextRateLimit(
  context: Context<ApiEnv>,
  deps: AppDeps,
  input: {
    binding: RateLimitBindingName;
    key: string;
    surface: RateLimitSurface;
    endpointId?: string;
  },
) {
  const url = new URL(context.req.url);

  return checkRateLimit({
    limiter: getRateLimiter(context, deps, input.binding),
    key: input.key,
    surface: input.surface,
    method: context.req.method,
    path: url.pathname,
    endpointId: input.endpointId,
  });
}

export async function enforceHttpRateLimit(
  context: Context<ApiEnv>,
  deps: AppDeps,
  input: {
    binding: RateLimitBindingName;
    key: string;
    surface: RateLimitSurface;
    endpointId?: string;
  },
) {
  const result = await checkContextRateLimit(context, deps, input);
  return result.kind === "error"
    ? respondRateLimitError(context, result)
    : null;
}

export async function enforceWriteRateLimits(
  context: Context<ApiEnv>,
  deps: AppDeps,
  endpointId?: string,
) {
  const ipRateLimited = await enforceHttpRateLimit(context, deps, {
    binding: "ABUSE_IP_RATE_LIMITER",
    key: clientIpRateLimitKey(context.req.raw),
    surface: "write",
    endpointId,
  });

  if (ipRateLimited !== null) {
    return ipRateLimited;
  }

  return enforceAuthenticatedWriteRateLimit(context, deps, {
    binding: "WRITE_RATE_LIMITER",
    surface: "write",
    endpointId,
  });
}

export async function enforcePatWriteRateLimits(
  context: Context<ApiEnv>,
  deps: AppDeps,
) {
  const ipRateLimited = await enforceHttpRateLimit(context, deps, {
    binding: "ABUSE_IP_RATE_LIMITER",
    key: clientIpRateLimitKey(context.req.raw),
    surface: "pat_write",
  });

  if (ipRateLimited !== null) return ipRateLimited;

  return enforceAuthenticatedWriteRateLimit(context, deps, {
    binding: "PAT_WRITE_RATE_LIMITER",
    surface: "pat_write",
  });
}

/** @public */
export function getWriteAuthentication(
  context: Context<ApiEnv>,
): PrincipalAuthenticationResult {
  return (
    context.get("writeAuthentication") ?? {
      kind: "error",
      code: "rate_limit_unavailable",
      message:
        "Request cannot be processed because abuse protection is unavailable.",
      status: 503,
    }
  );
}

async function enforceAuthenticatedWriteRateLimit(
  context: Context<ApiEnv>,
  deps: AppDeps,
  input: {
    binding: RateLimitBindingName;
    surface: "pat_write" | "write";
    endpointId?: string;
  },
) {
  const repository = getAuthDomainRepository(context, deps);
  const authentication = await authenticateResourcePrincipal(
    getAuthorizationHeader(context.req.raw),
    repository,
    deps.getNow(),
    { pepper: getCredentialPepper(context) },
    false,
  );
  context.set("writeAuthentication", authentication);

  const rateLimited = await enforceHttpRateLimit(context, deps, {
    ...input,
    key:
      authentication.kind === "ok"
        ? `token:${authentication.value.credential.id}`
        : clientIpRateLimitKey(context.req.raw),
  });

  if (rateLimited !== null || authentication.kind === "error") {
    return rateLimited;
  }

  await recordPrincipalLastUsed(
    authentication.value,
    repository,
    deps.getNow(),
  );
  context.set(
    "authenticatedWriteCredentialId",
    authentication.value.credential.id,
  );
  return null;
}
