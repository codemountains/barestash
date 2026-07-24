import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "./app.js";
import type { WebEnvironment } from "./auth/auth.js";

const environment: WebEnvironment = {
  DB: {} as D1Database,
  OAUTH_RATE_LIMITER: allowRateLimit(),
  DEVICE_APPROVAL_RATE_LIMITER: allowRateLimit(),
  BARESTASH_APP_ORIGIN: "https://app.example.com",
  BARESTASH_ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BARESTASH_CREDENTIAL_PEPPER: "pepper",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};

describe("createWebApp", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close();
    database = undefined;
  });

  it.each([
    undefined,
    "",
    "   ",
  ])("reports a missing credential pepper without a runtime TypeError", (credentialPepper) => {
    expect(() =>
      createWebApp({
        ...environment,
        BARESTASH_CREDENTIAL_PEPPER: credentialPepper as never,
      }),
    ).toThrowError("BARESTASH_CREDENTIAL_PEPPER must be configured.");
  });

  it("renders both supported provider sign-in actions", async () => {
    const app = await createWebApp(environment, { auth: fakeAuth() });

    const response = await app.request("https://app.example.com/");
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain('href="/assets/auth.css"');
    expect(markup).toContain('data-barestash-wordmark="true"');
    expect(markup).toContain("Sign in to Barestash");
    expect(markup).toContain("Continue with GitHub");
    expect(markup).toContain("Continue with Google");
    expect(markup.match(/btn btn-outline h-12 w-full text-base/g)).toHaveLength(
      2,
    );
    expect(markup).toContain('href="/device"');
    expect(markup).toContain("max-w-lg");
    expect(markup).toContain(
      'class="text-center text-base text-base-content/65"',
    );
  });

  it.each([
    ["/?theme=light", "barestash-light"],
    ["/device?theme=dark", "barestash-dark"],
  ])("overrides the OS theme for %s", async (path, expectedTheme) => {
    const app = await createWebApp(environment, { auth: fakeAuth() });
    const url = `https://app.example.com${path}`;
    const response = await app.request(url);
    const markup = await response.text();
    const dom = new JSDOM(markup, { runScripts: "dangerously", url });

    expect(markup.indexOf("data-theme-override")).toBeLessThan(
      markup.indexOf('rel="stylesheet"'),
    );
    expect(dom.window.document.documentElement.dataset.theme).toBe(
      expectedTheme,
    );
    dom.window.close();
  });

  it("ignores unsupported theme query values", async () => {
    const app = await createWebApp(environment, { auth: fakeAuth() });
    const url = "https://app.example.com/?theme=sepia";
    const response = await app.request(url);
    const dom = new JSDOM(await response.text(), {
      runScripts: "dangerously",
      url,
    });

    expect(dom.window.document.documentElement.hasAttribute("data-theme")).toBe(
      false,
    );
    dom.window.close();
  });

  it("renders an accessible segmented one-time-code form with a no-JavaScript fallback", async () => {
    const app = await createWebApp(environment, { auth: fakeAuth() });

    const response = await app.request("https://app.example.com/device");
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain("Enter your one-time code");
    expect(markup).toContain("max-w-lg");
    expect(markup.match(/data-device-code-input/g)).toHaveLength(8);
    expect(markup.match(/data-code-group/g)).toHaveLength(2);
    expect(markup).toContain('data-code-separator="true"');
    expect(markup.indexOf('data-code-group="first"')).toBeLessThan(
      markup.indexOf('data-code-separator="true"'),
    );
    expect(markup.indexOf('data-code-separator="true"')).toBeLessThan(
      markup.indexOf('data-code-group="second"'),
    );
    const dom = new JSDOM(markup);
    const fallback = dom.window.document.querySelector<HTMLFieldSetElement>(
      "[data-device-code-fallback]",
    );
    const enhanced = dom.window.document.querySelector<HTMLFieldSetElement>(
      "[data-device-code-fields]",
    );
    const enhancedValue = dom.window.document.querySelector<HTMLInputElement>(
      "[data-device-code-value]",
    );
    expect(fallback?.hidden).toBe(false);
    expect(fallback?.disabled).toBe(false);
    expect(enhanced?.hidden).toBe(true);
    expect(enhancedValue?.disabled).toBe(true);
    dom.window.close();
    expect(markup).toContain('name="code"');
    expect(markup).not.toContain("<noscript>");
    expect(markup).toContain("/assets/device-code.js");
    expect(markup).toContain(
      'class="btn btn-primary h-14 w-full" data-device-code-submit',
    );
  });

  it("keeps segmented code inputs inside their grid tracks after daisyUI styles", () => {
    const stylesheet = readFileSync(
      new URL("./presentation/auth.css", import.meta.url),
      "utf8",
    );

    expect(stylesheet).toContain(".input.device-code-input");
    expect(stylesheet).toMatch(
      /\.input\.device-code-input\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*height:\s*auto/s,
    );
    expect(
      cssBraceDepthAt(
        stylesheet,
        stylesheet.indexOf(".input.device-code-input"),
      ),
    ).toBe(0);
  });

  it("negotiates invalid user-code errors between browser HTML and the REST JSON shape", async () => {
    const app = await createWebApp(environment, { auth: fakeAuth() });

    const htmlResponse = await app.request(
      "https://app.example.com/device?code=invalid",
      { headers: { Accept: "text/html" } },
    );
    const html = await htmlResponse.text();
    const jsonResponse = await app.request(
      "https://app.example.com/device?code=invalid",
      { headers: { Accept: "application/json" } },
    );

    expect(htmlResponse.status).toBe(400);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(htmlResponse.headers.get("vary")).toContain("Accept");
    expect(html).toContain("The code is invalid or has expired");
    expect(html).toContain("Enter your one-time code");
    expect(html).not.toContain('value="invalid"');
    expect(jsonResponse.status).toBe(400);
    await expect(jsonResponse.json()).resolves.toEqual({
      error: {
        code: "invalid_user_code",
        message: "The user code is invalid.",
      },
    });
  });

  it("does not select HTML when JSON is explicit or HTML is unacceptable", async () => {
    const app = await createWebApp(environment, { auth: fakeAuth() });

    for (const accept of [
      "application/json, text/html;q=0.9",
      "text/html;q=0, */*;q=0.8",
    ]) {
      const response = await app.request(
        "https://app.example.com/device?code=invalid",
        { headers: { Accept: accept } },
      );

      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_user_code" },
      });
    }
  });

  it.each([
    "github",
    "google",
  ] as const)("forwards %s sign-in through the fixed Better Auth endpoint", async (provider) => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      `https://app.example.com/sign-in/${provider}?callbackURL=/device`,
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(204);
    expect(auth.handler).toHaveBeenCalledOnce();
    const request = auth.handler.mock.calls[0]?.[0];
    await expect(request?.json()).resolves.toEqual({
      provider,
      callbackURL: "https://app.example.com/device",
    });
  });

  it("renders OAuth start failures as HTML without changing JSON responses", async () => {
    const upstreamError = () =>
      Response.json(
        { code: "PROVIDER_NOT_CONFIGURED", message: "Provider unavailable." },
        { status: 400 },
      );
    const htmlApp = await createWebApp(environment, {
      auth: fakeAuth(upstreamError()),
    });
    const jsonApp = await createWebApp(environment, {
      auth: fakeAuth(upstreamError()),
    });
    const request = {
      method: "POST",
      headers: {
        Accept: "text/html",
        Origin: "https://app.example.com",
      },
    };

    const htmlResponse = await htmlApp.request(
      "https://app.example.com/sign-in/github",
      request,
    );
    const jsonResponse = await jsonApp.request(
      "https://app.example.com/sign-in/github",
      {
        ...request,
        headers: { ...request.headers, Accept: "application/json" },
      },
    );

    expect(htmlResponse.status).toBe(400);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(await htmlResponse.text()).toContain("Unable to start sign-in");
    expect(jsonResponse.status).toBe(400);
    await expect(jsonResponse.json()).resolves.toEqual({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Provider unavailable.",
    });
  });

  it("rejects an external callback URL before it reaches Better Auth", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      "https://app.example.com/sign-in/github?callbackURL=https://attacker.example/callback",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(400);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("rejects a malformed callback URL before it reaches Better Auth", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      "https://app.example.com/sign-in/github?callbackURL=http%3A%2F%2F%25",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(400);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("rejects browser sign-in requests from an untrusted origin", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      },
    );

    expect(response.status).toBe(403);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("forwards the OAuth start and callback only through the fixed app origin", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const start = await app.request(
      "https://app.example.com/sign-in/github?callbackURL=/device",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );
    const callback = await app.request(
      "https://app.example.com/api/auth/callback/github?state=state-value&code=code-value",
    );

    expect(start.status).toBe(204);
    expect(callback.status).toBe(204);
    expect(auth.handler).toHaveBeenCalledTimes(2);

    const [startRequest, callbackRequest] = auth.handler.mock.calls.map(
      ([request]) => request,
    );
    expect(startRequest.url).toBe(
      "https://app.example.com/api/auth/sign-in/social",
    );
    await expect(startRequest.json()).resolves.toEqual({
      provider: "github",
      callbackURL: "https://app.example.com/device",
    });
    expect(callbackRequest.url).toBe(
      "https://app.example.com/api/auth/callback/github?state=state-value&code=code-value",
    );
  });

  it("normalizes a trailing slash in the configured app origin", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(
      { ...environment, BARESTASH_APP_ORIGIN: "https://app.example.com/" },
      { auth },
    );

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(204);
    expect(auth.handler).toHaveBeenCalledOnce();
  });

  it("issues secure HttpOnly SameSite=Lax OAuth state cookies", async () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync(
        new URL("../../migrations/0001_better_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    const app = await createWebApp({ ...environment, DB: database as never });

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: { Origin: "https://app.example.com" },
      },
    );
    const cookies = getSetCookies(response.headers);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "github.com/login/oauth/authorize",
    );
    expect(cookies.join("\n")).toMatch(/HttpOnly/i);
    expect(cookies.join("\n")).toMatch(/Secure/i);
    expect(cookies.join("\n")).toMatch(/SameSite=Lax/i);
  });

  it("does not expose the Better Auth social sign-in endpoint directly", async () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync(
        new URL("../../migrations/0001_better_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    const app = await createWebApp({ ...environment, DB: database as never });

    const response = await app.request(
      "https://app.example.com/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: "https://app.example.com",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "https://attacker.example/callback",
        }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("does not expose direct social sign-in even to an untrusted origin", async () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync(
        new URL("../../migrations/0001_better_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    const app = await createWebApp({ ...environment, DB: database as never });

    const response = await app.request(
      "https://app.example.com/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "https://app.example.com/",
        }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("rejects callback URL query parameters before OAuth state is persisted", async () => {
    const auth = fakeAuth();
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      "https://app.example.com/sign-in/github?callbackURL=/device?code=JKLM-PQRS",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(400);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("redirects from the JSON OAuth response returned by Better Auth", async () => {
    const auth = fakeAuth(
      new Response(
        JSON.stringify({
          url: "https://github.com/login/oauth/authorize?state=example",
          redirect: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = await createWebApp(environment, { auth });

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      { method: "POST", headers: { Origin: "https://app.example.com" } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=example",
    );
  });

  it("rate limits OAuth initiation by client IP", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const auth = fakeAuth();
    const limiter = denyRateLimit();
    const app = await createWebApp(
      { ...environment, OAUTH_RATE_LIMITER: limiter },
      { auth },
    );

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: {
          Accept: "text/html",
          Origin: "https://app.example.com",
          "cf-connecting-ip": "203.0.113.10",
        },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("vary")).toContain("Accept");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await browserErrorActionHref(response)).toBe("/");
    expect(limiter.limit).toHaveBeenCalledWith({ key: "ip:203.0.113.10" });
    expect(auth.handler).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.rate_limit.exceeded",
        surface: "oauth_sign_in",
        method: "POST",
        path: "/sign-in/github",
        status: 429,
        error_code: "rate_limit_exceeded",
      }),
    );
    const jsonResponse = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: "https://app.example.com",
        },
      },
    );
    expect(jsonResponse.status).toBe(429);
    expect(jsonResponse.headers.get("retry-after")).toBe("60");
    await expect(jsonResponse.json()).resolves.toEqual({
      error: { code: "rate_limit_exceeded", message: "Too many requests." },
    });
  });

  it("fails closed when OAuth rate limiting is unavailable", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const auth = fakeAuth();
    const app = await createWebApp(
      {
        ...environment,
        OAUTH_RATE_LIMITER: {
          limit: vi.fn().mockRejectedValue(new Error("unavailable")),
        } as never,
      },
      { auth },
    );

    const response = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: {
          Accept: "text/html",
          Origin: "https://app.example.com",
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await browserErrorActionHref(response)).toBe("/");
    expect(auth.handler).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.rate_limit.failed",
        surface: "oauth_sign_in",
        method: "POST",
        path: "/sign-in/github",
        status: 503,
        error_code: "rate_limit_unavailable",
      }),
    );
    const jsonResponse = await app.request(
      "https://app.example.com/sign-in/github",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: "https://app.example.com",
        },
      },
    );
    expect(jsonResponse.status).toBe(503);
    expect(jsonResponse.headers.get("retry-after")).toBe("60");
    await expect(jsonResponse.json()).resolves.toEqual({
      error: {
        code: "rate_limit_unavailable",
        message:
          "Request cannot be processed because abuse protection is unavailable.",
      },
    });
  });

  it("renders the authenticated Device Authorization approval details", async () => {
    const deviceRepository = fakeDeviceRepository();
    const app = await createWebApp(environment, {
      auth: fakeAuthenticatedAuth(),
      deviceRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);

    const response = await app.request(
      "https://app.example.com/device?code=abcd-efgh",
    );
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain("Test User");
    expect(markup).toContain("user@example.com");
    expect(markup).toContain("barestash-cli");
    expect(markup).toContain("test-device");
    expect(markup).toContain("events:read");
    expect(markup).toContain("ABCD-EFGH");
    expect(markup).toContain('name="csrf_token"');
  });

  it("uses strict-origin Referrer-Policy so form POSTs keep a usable Origin without exposing the user code", async () => {
    // Fetch sets Origin to null for non-cors form POSTs when the document uses
    // Referrer-Policy: no-referrer, which breaks trusted-origin checks on
    // /sign-in/* and /device/{approve,deny}. strict-origin preserves a usable
    // Origin while limiting Referer to the origin, without the user-code query.
    const app = await createWebApp(environment, {
      auth: fakeAuth(),
      deviceRepository: fakeDeviceRepository(),
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);

    const response = await app.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
  });

  it("resumes verification_uri_complete after OAuth without putting the raw code in state", async () => {
    const deviceRepository = fakeDeviceRepository();
    const signedOutApp = await createWebApp(environment, {
      auth: fakeAuth(),
      deviceRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);
    const beforeSignIn = await signedOutApp.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );
    const cookie = beforeSignIn.headers.get("set-cookie") ?? "";
    const authenticatedApp = await createWebApp(environment, {
      auth: fakeAuthenticatedAuth(),
      deviceRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);

    const afterSignIn = await authenticatedApp.request(
      "https://app.example.com/device",
      { headers: { cookie: cookie.split(";")[0] ?? "" } },
    );

    expect(beforeSignIn.status).toBe(200);
    const beforeSignInMarkup = await beforeSignIn.text();
    expect(beforeSignInMarkup).toContain("Continue with GitHub");
    expect(beforeSignInMarkup).toContain("Continue with Google");
    expect(beforeSignInMarkup).toContain("/sign-in/google?callbackURL=/device");
    expect(beforeSignInMarkup).toContain("ABCD-EFGH");
    expect(cookie).not.toContain("ABCD-EFGH");
    expect(cookie).not.toContain("ABCDEFGH");
    expect(afterSignIn.status).toBe(200);
    const afterSignInMarkup = await afterSignIn.text();
    expect(afterSignInMarkup).toContain("ABCD-EFGH");
    expect(afterSignInMarkup).toContain("max-w-lg");
    expect(afterSignInMarkup).not.toContain("max-w-xl");
  });

  it("approves only with a session-bound CSRF token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceRepository = fakeDeviceRepository();
    const app = await createWebApp(environment, {
      auth: fakeAuthenticatedAuth(),
      deviceRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);
    const page = await app.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );
    const csrfToken = (await page.text()).match(
      /name="csrf_token" value="([^"]+)"/,
    )?.[1];

    const rejected = await app.request(
      "https://app.example.com/device/approve",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.com",
        },
        body: new URLSearchParams({
          authorization_id: "dva_test",
          csrf_token: "invalid",
        }),
      },
    );
    const approved = await app.request(
      "https://app.example.com/device/approve",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.com",
        },
        body: new URLSearchParams({
          authorization_id: "dva_test",
          csrf_token: csrfToken ?? "",
        }),
      },
    );

    expect(rejected.status).toBe(403);
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Device approved");
    expect(deviceRepository.approveDeviceAuthorization).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.device_authorization.approved",
        account_id: "acc_test",
        device_authorization_id: "dva_test",
      }),
    );
    expect(log.mock.calls.join("\n")).not.toContain("ABCD-EFGH");
  });

  it("requires a Better Auth session and rejects disabled approval accounts", async () => {
    const noSessionApp = await createWebApp(environment, {
      auth: fakeAuth(),
      deviceRepository: fakeDeviceRepository(),
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);
    const disabledRepository = fakeDeviceRepository({
      accountStatus: "disabled",
    });
    const disabledApp = await createWebApp(environment, {
      auth: fakeAuthenticatedAuth(),
      deviceRepository: disabledRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);
    const noSession = await noSessionApp.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );
    const noSessionApproval = await noSessionApp.request(
      "https://app.example.com/device/approve",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.com",
        },
        body: new URLSearchParams({
          authorization_id: "dva_test",
          csrf_token: "unused",
        }),
      },
    );
    const disabledPage = await disabledApp.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );
    const disabledHtmlPage = await disabledApp.request(
      "https://app.example.com/device?code=ABCD-EFGH",
      { headers: { Accept: "text/html" } },
    );

    expect(noSession.status).toBe(200);
    expect(await noSession.text()).toContain("Sign in to authorize a device");
    expect(noSessionApproval.status).toBe(401);
    expect(disabledPage.status).toBe(403);
    await expect(disabledPage.json()).resolves.toMatchObject({
      error: { code: "account_disabled" },
    });
    expect(disabledHtmlPage.status).toBe(403);
    expect(disabledHtmlPage.headers.get("content-type")).toContain("text/html");
    expect(await disabledHtmlPage.text()).toContain("Account unavailable");
  });

  it("denies a pending authorization with the same session and CSRF checks", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceRepository = fakeDeviceRepository();
    const app = await createWebApp(environment, {
      auth: fakeAuthenticatedAuth(),
      deviceRepository,
      now: () => new Date("2026-07-13T00:05:00.000Z"),
    } as never);
    const page = await app.request(
      "https://app.example.com/device?code=ABCD-EFGH",
    );
    const csrfToken = (await page.text()).match(
      /name="csrf_token" value="([^"]+)"/,
    )?.[1];

    const denied = await app.request("https://app.example.com/device/deny", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: "https://app.example.com",
      },
      body: new URLSearchParams({
        authorization_id: "dva_test",
        csrf_token: csrfToken ?? "",
      }),
    });

    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain("Device denied");
    expect(deviceRepository.denyDeviceAuthorization).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.device_authorization.denied",
        account_id: "acc_test",
        device_authorization_id: "dva_test",
      }),
    );
  });

  it("rate limits Device approval separately from OAuth", async () => {
    const approvalLimiter = denyRateLimit();
    const oauthLimiter = allowRateLimit();
    const app = await createWebApp(
      {
        ...environment,
        OAUTH_RATE_LIMITER: oauthLimiter,
        DEVICE_APPROVAL_RATE_LIMITER: approvalLimiter,
      },
      {
        auth: fakeAuthenticatedAuth(),
        deviceRepository: fakeDeviceRepository(),
      } as never,
    );

    const response = await app.request(
      "https://app.example.com/device?code=ABCD-EFGH",
      {
        headers: {
          Accept: "text/html",
          "cf-connecting-ip": "203.0.113.12",
        },
      },
    );

    expect(response.status).toBe(429);
    expect(await browserErrorActionHref(response)).toBe("/device");
    expect(approvalLimiter.limit).toHaveBeenCalledWith({
      key: "ip:203.0.113.12",
    });
    expect(oauthLimiter.limit).not.toHaveBeenCalled();
  });

  it("returns Device rate-limit failures to the Device page", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const app = await createWebApp(
      {
        ...environment,
        DEVICE_APPROVAL_RATE_LIMITER: {
          limit: vi.fn().mockRejectedValue(new Error("unavailable")),
        } as never,
      },
      {
        auth: fakeAuthenticatedAuth(),
        deviceRepository: fakeDeviceRepository(),
      } as never,
    );

    const response = await app.request("https://app.example.com/device", {
      headers: { Accept: "text/html" },
    });

    expect(response.status).toBe(503);
    expect(await browserErrorActionHref(response)).toBe("/device");
    expect(errorLog).toHaveBeenCalledOnce();
  });
});

function fakeAuth(response = new Response(null, { status: 204 })) {
  return {
    handler: vi.fn().mockResolvedValue(response),
  };
}

function cssBraceDepthAt(stylesheet: string, index: number): number {
  let depth = 0;
  for (const character of stylesheet.slice(0, index)) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
  }
  return depth;
}

async function browserErrorActionHref(
  response: Response,
): Promise<string | null> {
  const dom = new JSDOM(await response.text());
  const href =
    dom.window.document
      .querySelector<HTMLAnchorElement>(".auth-card a.btn")
      ?.getAttribute("href") ?? null;
  dom.window.close();
  return href;
}

function fakeAuthenticatedAuth() {
  return {
    ...fakeAuth(),
    api: {
      getSession: vi.fn().mockResolvedValue({
        session: { id: "browser-session" },
        user: { id: "better-auth-user" },
      }),
    },
  };
}

function fakeDeviceRepository(
  options: { accountStatus?: "active" | "disabled" } = {},
) {
  const authorization = {
    id: "dva_test",
    client_name: "barestash-cli",
    client_version: "0.1.0",
    device_name: "test-device",
    status: "pending",
    requested_scopes: ["events:read"],
    expires_at: "2026-07-13T00:10:00.000Z",
  };
  return {
    findDeviceAuthorizationByUserCodeHash: vi
      .fn()
      .mockResolvedValue(authorization),
    findDeviceAuthorizationById: vi.fn().mockResolvedValue(authorization),
    findBrowserAccount: vi.fn().mockResolvedValue({
      id: "acc_test",
      primary_email: "user@example.com",
      display_name: "Test User",
      status: options.accountStatus ?? "active",
    }),
    approveDeviceAuthorization: vi
      .fn()
      .mockResolvedValue({ ...authorization, status: "approved" }),
    denyDeviceAuthorization: vi
      .fn()
      .mockResolvedValue({ ...authorization, status: "denied" }),
  };
}

function allowRateLimit() {
  return { limit: vi.fn().mockResolvedValue({ success: true }) } as never;
}

function denyRateLimit() {
  return { limit: vi.fn().mockResolvedValue({ success: false }) } as never;
}

function getSetCookies(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;

  return getSetCookie?.call(headers) ?? [headers.get("set-cookie") ?? ""];
}
