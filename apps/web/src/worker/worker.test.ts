import { describe, expect, it, vi } from "vitest";

import { createWebWorker } from "./worker.js";

describe("createWebWorker", () => {
  it("reuses one app and Better Auth instance across requests in an isolate", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const createApp = vi.fn().mockResolvedValue({ fetch });
    const worker = createWebWorker(createApp as never);
    const environment = { DB: {} } as never;
    const executionContext = {} as ExecutionContext;

    await worker.fetch(
      new Request("https://app.example.com/"),
      environment,
      executionContext,
    );
    await worker.fetch(
      new Request("https://app.example.com/api/auth/get-session"),
      environment,
      executionContext,
    );

    expect(createApp).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
