import { err, ok, type UseCaseResult } from "./result.js";

/** @public */
export type RateLimitBinding = {
  limit: (input: { key: string }) => Promise<{ success: boolean }>;
};

/** @public */
export type RateLimitSurface =
  | "auth"
  | "device_creation"
  | "device_poll"
  | "endpoint_creation"
  | "ingest_endpoint"
  | "ingest_ip"
  | "mcp"
  | "mcp_ip"
  | "pat_write"
  | "refresh"
  | "sse"
  | "write";

/** @public */
export function clientIpRateLimitKey(request: Request): string {
  return `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
}

/** @public */
export async function checkRateLimit(input: {
  limiter: RateLimitBinding;
  key: string;
  surface: RateLimitSurface;
  method: string;
  path: string;
  endpointId?: string;
}): Promise<UseCaseResult<undefined>> {
  try {
    const result = await input.limiter.limit({ key: input.key });

    if (result.success) {
      return ok(undefined);
    }

    console.log(
      JSON.stringify({
        event: "barestash.rate_limit.exceeded",
        surface: input.surface,
        method: input.method,
        path: input.path,
        ...(input.endpointId === undefined
          ? {}
          : { endpoint_id: input.endpointId }),
        status: 429,
        error_code: "rate_limit_exceeded",
      }),
    );

    return err("rate_limit_exceeded", "Too many requests.", 429);
  } catch {
    console.error(
      JSON.stringify({
        event: "barestash.rate_limit.failed",
        surface: input.surface,
        method: input.method,
        path: input.path,
        ...(input.endpointId === undefined
          ? {}
          : { endpoint_id: input.endpointId }),
        status: 503,
        error_code: "rate_limit_unavailable",
      }),
    );

    return err(
      "rate_limit_unavailable",
      "Request cannot be processed because abuse protection is unavailable.",
      503,
    );
  }
}
