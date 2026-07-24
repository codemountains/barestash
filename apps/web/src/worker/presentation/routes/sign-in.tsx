import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { WebEnvironment } from "../../auth/auth.js";
import type { BrowserAuthHandler } from "../../auth/browser-auth-handler.js";
import { enforceBrowserRateLimit } from "../browser-rate-limit.js";
import {
  browserErrorResponse,
  prefersHtml,
  untrustedOriginResponse,
} from "../browser-response.js";
import { SignInPage } from "../sign-in-page.js";

type SignInRouteDependencies = {
  auth: Promise<BrowserAuthHandler>;
  appOrigin: string;
  rateLimiter: RateLimit;
};

/** @public */
export function registerSignInRoutes(
  app: Hono<{ Bindings: WebEnvironment }>,
  dependencies: SignInRouteDependencies,
): void {
  const { auth: authPromise, appOrigin, rateLimiter } = dependencies;

  app.get("/", (context) => context.html(<SignInPage />));

  app.post("/sign-in/:provider", async (context) => {
    const provider = context.req.param("provider");
    if (provider !== "github" && provider !== "google") {
      return context.notFound();
    }

    if (!isTrustedBrowserOrigin(context.req.raw, appOrigin)) {
      return untrustedOriginResponse(context);
    }

    const callbackURL = resolveCallbackURL(
      appOrigin,
      context.req.query("callbackURL"),
    );

    if (callbackURL === null) {
      return browserErrorResponse(context, {
        code: "invalid_callback_url",
        message:
          "The callback URL must use an allowed Barestash app path without query or fragment data.",
        status: 400,
        title: "Invalid sign-in request",
        description: "Return to Barestash and start the sign-in flow again.",
        actionHref: "/",
        actionLabel: "Back to sign in",
      });
    }

    const rateLimitError = await enforceBrowserRateLimit(
      context.req.raw,
      rateLimiter,
      "oauth_sign_in",
    );
    if (rateLimitError !== null) {
      return browserErrorResponse(context, rateLimitError);
    }

    const auth = await authPromise;
    const headers = new Headers(context.req.raw.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.delete("content-length");

    const response = await auth.handler(
      new Request(new URL("/api/auth/sign-in/social", appOrigin), {
        method: "POST",
        headers,
        body: JSON.stringify({ provider, callbackURL }),
      }),
    );

    if (response.status >= 400 && prefersHtml(context.req.raw)) {
      return browserErrorResponse(context, {
        code: "oauth_start_failed",
        message: "The OAuth sign-in flow could not be started.",
        status: response.status as ContentfulStatusCode,
        title: "Unable to start sign-in",
        description:
          "The selected sign-in provider is unavailable. Return to Barestash and try again.",
        actionHref: "/",
        actionLabel: "Back to sign in",
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }

    return redirectToOAuthProvider(response);
  });

  app.post("/api/auth/sign-in/social", (context) => context.notFound());
  app.post("/api/auth/link-social", (context) => context.notFound());
  app.post("/api/auth/unlink-account", (context) => context.notFound());

  app.on(["GET", "POST"], "/api/auth/*", async (context) =>
    (await authPromise).handler(context.req.raw),
  );
}

async function redirectToOAuthProvider(response: Response): Promise<Response> {
  if (response.status !== 200) return response;

  const location =
    response.headers.get("location") ?? (await oauthRedirectFromJson(response));
  if (location === null) return response;

  const headers = new Headers(response.headers);
  headers.set("location", location);
  headers.delete("content-length");
  headers.delete("content-type");

  return new Response(null, { status: 302, headers });
}

function resolveCallbackURL(
  appOrigin: string,
  candidate: string | undefined,
): string | null {
  let url: URL;

  try {
    url = new URL(candidate ?? "/", appOrigin);
  } catch {
    return null;
  }

  if (
    url.origin !== appOrigin ||
    !["/", "/device"].includes(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  return url.toString();
}

async function oauthRedirectFromJson(
  response: Response,
): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      redirect?: unknown;
      url?: unknown;
    };
    if (body.redirect !== true || typeof body.url !== "string") return null;

    const url = new URL(body.url);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isTrustedBrowserOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}
