import { createRestErrorResponse } from "@barestash/shared/errors";
import type { Context } from "hono";

import type { UseCaseError } from "../application/result.js";
import type { ApiEnv } from "../container.js";

export function respondUseCaseError(
  context: Context<ApiEnv>,
  error: UseCaseError,
) {
  return context.json(
    createRestErrorResponse(error.code, error.message),
    error.status,
  );
}

export function respondRateLimitError(
  context: Context<ApiEnv>,
  error: UseCaseError,
) {
  return context.json(
    createRestErrorResponse(error.code, error.message),
    error.status,
    { "retry-after": "60" },
  );
}
