import type { CliFetch } from "../../domain/ports.js";
import { validateRedirectTarget } from "./api-url.js";

export type SecureFetchOptions = {
  allowInsecure?: boolean;
  maxRedirects?: number;
};

const DEFAULT_MAX_REDIRECTS = 5;

/** @public */
export function createSecureFetch(
  fetchImpl: CliFetch,
  options: SecureFetchOptions = {},
): CliFetch {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return async (input, init) => {
    let currentUrl = resolveRequestUrl(input);
    let currentInit = init;
    let redirectCount = 0;

    while (true) {
      validateRedirectTarget(currentUrl, {
        allowInsecure: options.allowInsecure,
      });

      const response = await fetchImpl(
        currentUrl,
        withManualRedirect(currentInit),
      );

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      if (redirectCount >= maxRedirects) {
        throw new Error("Barestash API redirect limit exceeded.");
      }

      const location = response.headers.get("location");

      if (location === null || location.length === 0) {
        throw new Error("Barestash API redirect is missing a Location header.");
      }

      const redirectUrl = new URL(location, currentUrl).toString();
      validateRedirectTarget(redirectUrl, {
        allowInsecure: options.allowInsecure,
      });
      assertSameOriginRedirect(currentUrl, redirectUrl);

      currentUrl = redirectUrl;
      currentInit = redirectFollowupInit(currentInit, response.status);
      redirectCount += 1;
    }
  };
}

function resolveRequestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function withManualRedirect(init?: RequestInit): RequestInit {
  return {
    ...init,
    redirect: "manual",
  };
}

function redirectFollowupInit(
  init: RequestInit | undefined,
  status: number,
): RequestInit | undefined {
  if (init === undefined) {
    return undefined;
  }

  if (status === 307 || status === 308) {
    return init;
  }

  const method = (init.method ?? "GET").toUpperCase();

  if (status === 303) {
    if (method !== "GET" && method !== "HEAD") {
      return {
        ...init,
        method: "GET",
        body: undefined,
      };
    }

    return init;
  }

  if (method === "POST") {
    return {
      ...init,
      method: "GET",
      body: undefined,
    };
  }

  return init;
}

function assertSameOriginRedirect(
  currentUrl: string,
  redirectUrl: string,
): void {
  const currentOrigin = new URL(currentUrl).origin;
  const redirectOrigin = new URL(redirectUrl).origin;

  if (currentOrigin !== redirectOrigin) {
    throw new Error(
      "Barestash API redirect to a different origin is not allowed.",
    );
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
