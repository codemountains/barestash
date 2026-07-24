import type { Hono } from "hono";

import type { ApiEnv } from "../../container.js";

/** @public */
export function registerHealthRoutes(app: Hono<ApiEnv>): void {
  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "barestash-api",
    }),
  );

  app.get("/v1/dev/health", (context) =>
    context.json({
      ok: true,
      service: "barestash-api",
      version: "v1",
    }),
  );
}
