import type { BrowserError } from "./browser-response.js";

type BrowserRateLimitSurface = "oauth_sign_in" | "device_approval";

/** @public */
export async function enforceBrowserRateLimit(
  request: Request,
  limiter: RateLimit,
  surface: BrowserRateLimitSurface,
): Promise<BrowserError | null> {
  try {
    const result = await limiter.limit({
      key: `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    });
    if (result.success) return null;

    console.log(
      JSON.stringify(
        rateLimitLog(request, 429, "rate_limit_exceeded", surface),
      ),
    );

    return {
      code: "rate_limit_exceeded",
      message: "Too many requests.",
      status: 429,
      title: "Too many attempts",
      description: "Wait a minute, then try again.",
      actionHref: surface === "oauth_sign_in" ? "/" : "/device",
      actionLabel: "Try again",
      retryAfter: "60",
    };
  } catch {
    console.error(
      JSON.stringify(
        rateLimitLog(request, 503, "rate_limit_unavailable", surface),
      ),
    );
    return {
      code: "rate_limit_unavailable",
      message:
        "Request cannot be processed because abuse protection is unavailable.",
      status: 503,
      title:
        surface === "oauth_sign_in"
          ? "Sign-in is temporarily unavailable"
          : "Authorization is temporarily unavailable",
      description: "Please try again in a moment.",
      actionHref: surface === "oauth_sign_in" ? "/" : "/device",
      actionLabel:
        surface === "oauth_sign_in" ? "Back to sign in" : "Try again",
      retryAfter: "60",
    };
  }
}

function rateLimitLog(
  request: Request,
  status: 429 | 503,
  errorCode: "rate_limit_exceeded" | "rate_limit_unavailable",
  surface: BrowserRateLimitSurface,
) {
  return {
    event:
      status === 429
        ? "barestash.rate_limit.exceeded"
        : "barestash.rate_limit.failed",
    surface,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    error_code: errorCode,
  };
}
