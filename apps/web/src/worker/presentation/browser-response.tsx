import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { WebEnvironment } from "../auth/auth.js";
import { BrowserErrorPage, DeviceCodePage } from "./device-page.js";

type WebContext = Context<{ Bindings: WebEnvironment }>;

type BrowserResponse = Response | Promise<Response>;

export type BrowserError = {
  code: string;
  message: string;
  status: ContentfulStatusCode;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  retryAfter?: string;
};

/** @public */
export function invalidUserCodeResponse(context: WebContext): BrowserResponse {
  const error = {
    code: "invalid_user_code",
    message: "The user code is invalid.",
    status: 400,
    title: "We couldn't verify that code",
    description:
      "The code is invalid or has expired. Check the code shown in your terminal and try again.",
    actionHref: "/device",
    actionLabel: "Enter another code",
  } satisfies BrowserError;

  if (!prefersHtml(context.req.raw)) {
    return browserErrorResponse(context, error);
  }

  setBrowserErrorHeaders(context, error);
  return context.html(<DeviceCodePage error={error.description} />, 400);
}

/** @public */
export function invalidCsrfResponse(context: WebContext): BrowserResponse {
  return browserErrorResponse(context, {
    code: "invalid_csrf_token",
    message: "The CSRF token is invalid.",
    status: 403,
    title: "Authorization expired",
    description: "Enter the one-time code again to restart authorization.",
    actionHref: "/device",
    actionLabel: "Enter a code",
  });
}

/** @public */
export function authenticationRequiredResponse(
  context: WebContext,
): BrowserResponse {
  return browserErrorResponse(context, {
    code: "not_authenticated",
    message: "A browser session is required.",
    status: 401,
    title: "Sign-in required",
    description: "Enter the one-time code again, then sign in to continue.",
    actionHref: "/device",
    actionLabel: "Enter a code",
  });
}

/** @public */
export function accountDisabledResponse(context: WebContext): BrowserResponse {
  return browserErrorResponse(context, {
    code: "account_disabled",
    message: "The account is disabled.",
    status: 403,
    title: "Account unavailable",
    description: "This account cannot authorize a Barestash device.",
    actionHref: "/",
    actionLabel: "Back to sign in",
  });
}

/** @public */
export function untrustedOriginResponse(context: WebContext): BrowserResponse {
  return browserErrorResponse(context, {
    code: "untrusted_origin",
    message: "Browser sign-in requests must originate from the Barestash app.",
    status: 403,
    title: "Request blocked",
    description: "Return to Barestash and start the sign-in flow again.",
    actionHref: "/",
    actionLabel: "Back to sign in",
  });
}

/** @public */
export function browserErrorResponse(
  context: WebContext,
  error: BrowserError,
): BrowserResponse {
  setBrowserErrorHeaders(context, error);
  if (prefersHtml(context.req.raw)) {
    return context.html(
      <BrowserErrorPage
        title={error.title}
        message={error.description}
        actionHref={error.actionHref}
        actionLabel={error.actionLabel}
      />,
      error.status,
    );
  }

  return context.json(
    { error: { code: error.code, message: error.message } },
    error.status,
  );
}

function setBrowserErrorHeaders(
  context: WebContext,
  error: BrowserError,
): void {
  context.header("Cache-Control", "no-store");
  context.header("Pragma", "no-cache");
  context.header("Referrer-Policy", "no-referrer");
  context.header("Vary", "Accept");
  if (error.retryAfter !== undefined) {
    context.header("Retry-After", error.retryAfter);
  }
}

/** @public */
export function prefersHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (accept === null || acceptsMediaType(accept, "application/json")) {
    return false;
  }
  return acceptsMediaType(accept, "text/html");
}

function acceptsMediaType(accept: string, mediaType: string): boolean {
  return accept.split(",").some((entry) => {
    const [range, ...parameters] = entry.trim().toLowerCase().split(";");
    if (range !== mediaType) return false;

    const qualityParameter = parameters.find(
      (parameter) => parameter.trim().split("=")[0] === "q",
    );
    if (qualityParameter === undefined) return true;

    const quality = Number(qualityParameter.split("=")[1]?.trim());
    return Number.isFinite(quality) && quality > 0;
  });
}
