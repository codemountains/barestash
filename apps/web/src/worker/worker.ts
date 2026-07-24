import { createWebApp } from "./app.js";
import type { WebEnvironment } from "./auth/auth.js";

type WebApp = Awaited<ReturnType<typeof createWebApp>>;
type WebAppFactory = (environment: WebEnvironment) => WebApp | Promise<WebApp>;

export function createWebWorker(createApp: WebAppFactory = createWebApp) {
  let appPromise: Promise<WebApp> | undefined;

  return {
    async fetch(request, environment, executionContext) {
      appPromise ??= Promise.resolve(createApp(environment));
      const app = await appPromise;
      return app.fetch(request, environment, executionContext);
    },
  } satisfies ExportedHandler<WebEnvironment>;
}

export default createWebWorker();
