import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { logAuthAudit } from "../../application/auth-audit.js";
import {
  type DeviceApprovalRepository,
  displayUserCode,
  hashDeviceUserCode,
  normalizeUserCode,
} from "../../application/device-approval.js";
import {
  createDeviceContinuation,
  readDeviceContinuation,
} from "../../application/device-continuation.js";
import {
  createDeviceCsrfToken,
  verifyDeviceCsrfToken,
} from "../../application/device-csrf.js";
import type { WebEnvironment } from "../../auth/auth.js";
import type { BrowserAuthHandler } from "../../auth/browser-auth-handler.js";
import { enforceBrowserRateLimit } from "../browser-rate-limit.js";
import {
  accountDisabledResponse,
  authenticationRequiredResponse,
  browserErrorResponse,
  invalidCsrfResponse,
  invalidUserCodeResponse,
  untrustedOriginResponse,
} from "../browser-response.js";
import {
  DeviceApprovalPage,
  DeviceCodePage,
  DeviceDecisionPage,
  DeviceSignInPage,
} from "../device-page.js";

type DeviceApprovalRouteDependencies = {
  auth: Promise<BrowserAuthHandler>;
  appOrigin: string;
  continuationCookie: string;
  credentialPepper: string;
  deviceRepository: DeviceApprovalRepository;
  getNow: () => Date;
  rateLimiter: RateLimit;
  secret: string;
};

/** @public */
export function registerDeviceApprovalRoutes(
  app: Hono<{ Bindings: WebEnvironment }>,
  dependencies: DeviceApprovalRouteDependencies,
): void {
  const {
    auth: authPromise,
    appOrigin,
    continuationCookie,
    credentialPepper,
    deviceRepository,
    getNow,
    rateLimiter,
    secret,
  } = dependencies;

  app.get("/device", async (context) => {
    setDeviceResponseHeaders(context);
    const rateLimitError = await enforceBrowserRateLimit(
      context.req.raw,
      rateLimiter,
      "device_approval",
    );
    if (rateLimitError !== null) {
      return browserErrorResponse(context, rateLimitError);
    }

    const auth = await authPromise;
    const session = await getBrowserSession(auth, context.req.raw.headers);
    const code = context.req.query("code");
    let normalizedCode: string | null = null;
    let authorization = null;

    if (code !== undefined) {
      normalizedCode = normalizeUserCode(code);
      if (normalizedCode === null) return invalidUserCodeResponse(context);
      authorization =
        await deviceRepository.findDeviceAuthorizationByUserCodeHash(
          await hashDeviceUserCode(normalizedCode, credentialPepper),
        );
    } else if (session !== null) {
      const continuationToken = getCookie(context, continuationCookie);
      const continuation =
        continuationToken === undefined
          ? null
          : await readDeviceContinuation(continuationToken, {
              secret,
              now: getNow(),
            });
      if (continuationToken !== undefined && continuation === null) {
        clearDeviceContinuationCookie(context, continuationCookie, appOrigin);
      }
      if (continuation !== null) {
        normalizedCode = continuation.userCode;
        authorization = await deviceRepository.findDeviceAuthorizationById(
          continuation.authorizationId as `dva_${string}`,
        );
        if (authorization?.expires_at !== continuation.expiresAt) {
          authorization = null;
          clearDeviceContinuationCookie(context, continuationCookie, appOrigin);
        }
      }
    }

    if (normalizedCode === null) return context.html(<DeviceCodePage />);
    if (
      authorization === null ||
      authorization.status !== "pending" ||
      Date.parse(authorization.expires_at) <= getNow().getTime()
    ) {
      return invalidUserCodeResponse(context);
    }
    if (session === null) {
      setCookie(
        context,
        continuationCookie,
        await createDeviceContinuation({
          secret,
          authorizationId: authorization.id,
          userCode: normalizedCode,
          expiresAt: authorization.expires_at,
        }),
        {
          httpOnly: true,
          secure: appOrigin.startsWith("https://"),
          sameSite: "Lax",
          path: "/device",
          maxAge: Math.max(
            0,
            Math.floor(
              (Date.parse(authorization.expires_at) - getNow().getTime()) /
                1_000,
            ),
          ),
        },
      );
      return context.html(
        <DeviceSignInPage userCode={displayUserCode(normalizedCode)} />,
      );
    }
    const account = await deviceRepository.findBrowserAccount(session.user.id);
    if (account === null) return authenticationRequiredResponse(context);
    if (account.status === "disabled") return accountDisabledResponse(context);
    const csrfToken = await createDeviceCsrfToken({
      secret,
      sessionId: session.session.id,
      authorizationId: authorization.id,
      expiresAt: authorization.expires_at,
    });
    return context.html(
      <DeviceApprovalPage
        account={account}
        authorization={authorization}
        userCode={displayUserCode(normalizedCode)}
        csrfToken={csrfToken}
      />,
    );
  });

  for (const decision of ["approve", "deny"] as const) {
    app.post(`/device/${decision}`, async (context) => {
      setDeviceResponseHeaders(context);
      if (!isTrustedBrowserOrigin(context.req.raw, appOrigin)) {
        return untrustedOriginResponse(context);
      }
      const rateLimitError = await enforceBrowserRateLimit(
        context.req.raw,
        rateLimiter,
        "device_approval",
      );
      if (rateLimitError !== null) {
        return browserErrorResponse(context, rateLimitError);
      }
      const auth = await authPromise;
      const session = await getBrowserSession(auth, context.req.raw.headers);
      if (session === null) return authenticationRequiredResponse(context);
      const form = await context.req.formData();
      const authorizationId = form.get("authorization_id");
      const csrfToken = form.get("csrf_token");
      if (
        typeof authorizationId !== "string" ||
        typeof csrfToken !== "string"
      ) {
        return invalidCsrfResponse(context);
      }
      const authorization = await deviceRepository.findDeviceAuthorizationById(
        authorizationId as `dva_${string}`,
      );
      if (authorization === null) return invalidUserCodeResponse(context);
      const validCsrf = await verifyDeviceCsrfToken(csrfToken, {
        secret,
        sessionId: session.session.id,
        authorizationId: authorization.id,
        now: getNow(),
      });
      if (!validCsrf) return invalidCsrfResponse(context);
      const account = await deviceRepository.findBrowserAccount(
        session.user.id,
      );
      if (account === null) return authenticationRequiredResponse(context);
      if (decision === "approve" && account.status === "disabled") {
        return accountDisabledResponse(context);
      }
      const decided =
        decision === "approve"
          ? await deviceRepository.approveDeviceAuthorization(
              authorization.id,
              account.id,
              getNow().toISOString(),
            )
          : await deviceRepository.denyDeviceAuthorization(
              authorization.id,
              getNow().toISOString(),
            );
      if (decided === null) return invalidUserCodeResponse(context);
      logAuthAudit({
        event:
          decision === "approve"
            ? "barestash.auth.device_authorization.approved"
            : "barestash.auth.device_authorization.denied",
        account_id: account.id,
        device_authorization_id: authorization.id,
      });
      clearDeviceContinuationCookie(context, continuationCookie, appOrigin);
      return context.html(
        <DeviceDecisionPage approved={decision === "approve"} />,
      );
    });
  }
}

async function getBrowserSession(auth: BrowserAuthHandler, headers: Headers) {
  return auth.api?.getSession({ headers }) ?? null;
}

function setDeviceResponseHeaders(context: {
  header(name: string, value: string): void;
}) {
  context.header("Cache-Control", "no-store");
  context.header("Pragma", "no-cache");
  // strict-origin limits Referer to the app origin (so user codes in
  // /device?code=... are not leaked) without nulling Origin on form POSTs.
  // Referrer-Policy: no-referrer makes browsers send Origin: null for non-cors
  // form submissions, which breaks trusted-origin checks on sign-in/approve.
  context.header("Referrer-Policy", "strict-origin");
}

function clearDeviceContinuationCookie(
  context: Parameters<typeof deleteCookie>[0],
  cookieName: string,
  appOrigin: string,
) {
  deleteCookie(context, cookieName, {
    path: "/device",
    secure: appOrigin.startsWith("https://"),
  });
}

function isTrustedBrowserOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}
