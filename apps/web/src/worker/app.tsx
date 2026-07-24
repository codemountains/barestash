import { Hono } from "hono";

import type { DeviceApprovalRepository } from "./application/device-approval.js";
import { createBrowserAuth, type WebEnvironment } from "./auth/auth.js";
import type { BrowserAuthHandler } from "./auth/browser-auth-handler.js";
import { D1DeviceApprovalRepository } from "./infrastructure/d1/device-approval-repository.js";
import { registerDeviceApprovalRoutes } from "./presentation/routes/device-approval.js";
import { registerSignInRoutes } from "./presentation/routes/sign-in.js";

export type CreateWebAppOptions = {
  auth?: BrowserAuthHandler;
  deviceRepository?: DeviceApprovalRepository;
  now?: () => Date;
};

export function createWebApp(
  environment: WebEnvironment,
  options: CreateWebAppOptions = {},
) {
  if (
    typeof environment.BARESTASH_CREDENTIAL_PEPPER !== "string" ||
    environment.BARESTASH_CREDENTIAL_PEPPER.trim() === ""
  ) {
    throw new Error("BARESTASH_CREDENTIAL_PEPPER must be configured.");
  }

  const app = new Hono<{ Bindings: WebEnvironment }>();
  const authPromise = Promise.resolve(
    options.auth ?? createBrowserAuth(environment),
  );
  const appOrigin = new URL(environment.BARESTASH_APP_ORIGIN).origin;
  const deviceRepository =
    options.deviceRepository ?? new D1DeviceApprovalRepository(environment.DB);
  const getNow = options.now ?? (() => new Date());

  registerSignInRoutes(app, {
    auth: authPromise,
    appOrigin,
    rateLimiter: environment.OAUTH_RATE_LIMITER,
  });
  registerDeviceApprovalRoutes(app, {
    auth: authPromise,
    appOrigin,
    continuationCookie: deviceContinuationCookieName(appOrigin),
    credentialPepper: environment.BARESTASH_CREDENTIAL_PEPPER,
    deviceRepository,
    getNow,
    rateLimiter: environment.DEVICE_APPROVAL_RATE_LIMITER,
    secret: environment.BETTER_AUTH_SECRET,
  });

  return app;
}

function deviceContinuationCookieName(appOrigin: string): string {
  return appOrigin.startsWith("https://")
    ? "__Secure-barestash-device-continuation"
    : "barestash-device-continuation";
}
