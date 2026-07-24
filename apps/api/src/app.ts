import { createRestErrorResponse } from "@barestash/shared/errors";
import { isEndpointId } from "@barestash/shared/ids";
import { Hono } from "hono";

import {
  type ApiEnv,
  type CreateApiAppOptions,
  createAppDeps,
  RATE_LIMIT_BINDING_NAMES,
} from "./container.js";
import { registerAccountRoutes } from "./presentation/routes/account.js";
import { registerCliSessionRoutes } from "./presentation/routes/cli-session.js";
import { registerDeviceAuthorizationRoutes } from "./presentation/routes/device-authorization.js";
import { registerEndpointRoutes } from "./presentation/routes/endpoints.js";
import {
  registerEventRoutes,
  registerEventStreamRoutes,
} from "./presentation/routes/events.js";
import { registerHealthRoutes } from "./presentation/routes/health.js";
import { registerIngestRoutes } from "./presentation/routes/ingest.js";
import { registerMcpRoutes } from "./presentation/routes/mcp.js";
import { registerTokenRoutes } from "./presentation/routes/tokens.js";

type CreateApiAppRuntimeOptions = {
  validateRuntimeBindings: boolean;
};

export function createApiApp(
  options: CreateApiAppOptions = {},
  runtimeOptions: CreateApiAppRuntimeOptions = {
    validateRuntimeBindings: true,
  },
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const deps = createAppDeps(options);
  let hasLoggedInvalidConfiguration = false;

  app.use("*", async (context, next) => {
    const apiHostname = context.env?.BARESTASH_API_HOSTNAME;
    const ingestHostname = context.env?.BARESTASH_INGEST_HOSTNAME;

    if (apiHostname === undefined || ingestHostname === undefined) {
      await next();
      return;
    }

    const requestUrl = new URL(context.req.url);
    const pathSegments = requestUrl.pathname.split("/");
    const isApiSurface =
      requestUrl.pathname === "/health" ||
      requestUrl.pathname === "/mcp" ||
      requestUrl.pathname.startsWith("/mcp/") ||
      requestUrl.pathname === "/v1" ||
      requestUrl.pathname.startsWith("/v1/");
    const isIngestSurface = isEndpointId(pathSegments[1] ?? "");
    const isAllowed =
      (requestUrl.hostname === apiHostname && isApiSurface) ||
      (requestUrl.hostname === ingestHostname && isIngestSurface);

    if (!isAllowed) {
      return context.notFound();
    }

    await next();
  });

  app.use("*", async (context, next) => {
    if (!runtimeOptions.validateRuntimeBindings) {
      await next();
      return;
    }

    const credentialPepper = context.env?.BARESTASH_CREDENTIAL_PEPPER;
    const missingBindings = [
      context.env?.DB === undefined ? "DB" : undefined,
      context.env?.REQUEST_BODIES === undefined ? "REQUEST_BODIES" : undefined,
      context.env?.ENDPOINT_STREAMS === undefined
        ? "ENDPOINT_STREAMS"
        : undefined,
      credentialPepper === undefined || credentialPepper === ""
        ? "BARESTASH_CREDENTIAL_PEPPER"
        : undefined,
      context.env?.BARESTASH_API_HOSTNAME !== undefined &&
      context.env?.BARESTASH_INGEST_HOSTNAME === undefined
        ? "BARESTASH_INGEST_HOSTNAME"
        : undefined,
      context.env?.BARESTASH_INGEST_HOSTNAME !== undefined &&
      context.env?.BARESTASH_API_HOSTNAME === undefined
        ? "BARESTASH_API_HOSTNAME"
        : undefined,
      ...RATE_LIMIT_BINDING_NAMES.filter(
        (name) => context.env?.[name] === undefined,
      ),
    ].filter((binding): binding is string => binding !== undefined);

    if (missingBindings.length === 0) {
      await next();
      return;
    }

    if (!hasLoggedInvalidConfiguration) {
      console.error(
        JSON.stringify({
          event: "barestash.configuration.invalid",
          missing_bindings: missingBindings,
        }),
      );
      hasLoggedInvalidConfiguration = true;
    }

    return context.json(
      createRestErrorResponse(
        "internal_error",
        `Required runtime bindings are not configured: ${missingBindings.join(", ")}.`,
      ),
      500,
    );
  });

  registerHealthRoutes(app);
  registerAccountRoutes(app, deps);
  registerDeviceAuthorizationRoutes(app, deps);
  registerCliSessionRoutes(app, deps);
  registerTokenRoutes(app, deps);
  registerEndpointRoutes(app, deps);
  registerEventStreamRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerIngestRoutes(app, deps);

  return app;
}

export const apiApp = createApiApp();
