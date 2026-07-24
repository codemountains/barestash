import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app.js";
import { createTestApiApp } from "./testing/api-app.js";
import worker from "./worker.js";

const allowRateLimiter = {
  async limit() {
    return { success: true };
  },
} as RateLimit;

const configuredRateLimiters = {
  ABUSE_IP_RATE_LIMITER: allowRateLimiter,
  INGEST_ENDPOINT_RATE_LIMITER: allowRateLimiter,
  ENDPOINT_CREATION_RATE_LIMITER: allowRateLimiter,
  PAT_WRITE_RATE_LIMITER: allowRateLimiter,
  REFRESH_RATE_LIMITER: allowRateLimiter,
  DEVICE_CREATION_RATE_LIMITER: allowRateLimiter,
  DEVICE_POLL_RATE_LIMITER: allowRateLimiter,
  MCP_RATE_LIMITER: allowRateLimiter,
  WRITE_RATE_LIMITER: allowRateLimiter,
  SSE_RATE_LIMITER: allowRateLimiter,
};
const configuredEndpointStreams = {} as DurableObjectNamespace;

describe("API Worker", () => {
  it("keeps API and ingest routes on their configured host surfaces", async () => {
    const app = createTestApiApp();
    const env = {
      BARESTASH_API_HOSTNAME: "api.example.com",
      BARESTASH_INGEST_HOSTNAME: "ingest.example.com",
    };
    const createResponse = await app.request(
      "https://api.example.com/v1/endpoints",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "temporary" }),
      },
      env,
    );
    const createBody = (await createResponse.json()) as {
      endpoint: { id: string };
    };

    expect(createResponse.status).toBe(201);
    expect(
      await app.request(
        `https://api.example.com/${createBody.endpoint.id}`,
        { method: "POST", body: "api-host bypass" },
        env,
      ),
    ).toHaveProperty("status", 404);
    expect(
      await app.request(
        "https://ingest.example.com/v1/endpoints",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "temporary" }),
        },
        env,
      ),
    ).toHaveProperty("status", 404);
    expect(
      await app.request(
        `https://ingest.example.com/${createBody.endpoint.id}`,
        { method: "POST", body: "webhook" },
        env,
      ),
    ).toHaveProperty("status", 204);
    expect(
      await app.request("https://api.example.com/health", undefined, env),
    ).toHaveProperty("status", 200);
  });

  it("builds ingest URLs from the configured ingest hostname", async () => {
    const app = createTestApiApp();
    const env = {
      BARESTASH_API_HOSTNAME: "control.example.com",
      BARESTASH_INGEST_HOSTNAME: "hooks.example.com",
    };
    const createResponse = await app.request(
      "https://control.example.com/v1/endpoints",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "temporary" }),
      },
      env,
    );
    const createBody = (await createResponse.json()) as {
      endpoint: { id: string; ingest_url: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createBody.endpoint.ingest_url).toBe(
      `https://hooks.example.com/${createBody.endpoint.id}`,
    );
    expect(
      await app.request(
        `${createBody.endpoint.ingest_url}/webhook`,
        { method: "POST", body: "webhook" },
        env,
      ),
    ).toHaveProperty("status", 204);
  });

  it("fails closed and logs missing persistent storage bindings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await worker.fetch?.(
      new Request("http://localhost/health"),
      {},
      {} as ExecutionContext,
    );

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      error: {
        code: "internal_error",
        message:
          "Required runtime bindings are not configured: DB, REQUEST_BODIES, ENDPOINT_STREAMS, BARESTASH_CREDENTIAL_PEPPER, ABUSE_IP_RATE_LIMITER, INGEST_ENDPOINT_RATE_LIMITER, ENDPOINT_CREATION_RATE_LIMITER, PAT_WRITE_RATE_LIMITER, REFRESH_RATE_LIMITER, DEVICE_CREATION_RATE_LIMITER, DEVICE_POLL_RATE_LIMITER, MCP_RATE_LIMITER, WRITE_RATE_LIMITER, SSE_RATE_LIMITER.",
      },
    });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.configuration.invalid",
        missing_bindings: [
          "DB",
          "REQUEST_BODIES",
          "ENDPOINT_STREAMS",
          "BARESTASH_CREDENTIAL_PEPPER",
          "ABUSE_IP_RATE_LIMITER",
          "INGEST_ENDPOINT_RATE_LIMITER",
          "ENDPOINT_CREATION_RATE_LIMITER",
          "PAT_WRITE_RATE_LIMITER",
          "REFRESH_RATE_LIMITER",
          "DEVICE_CREATION_RATE_LIMITER",
          "DEVICE_POLL_RATE_LIMITER",
          "MCP_RATE_LIMITER",
          "WRITE_RATE_LIMITER",
          "SSE_RATE_LIMITER",
        ],
      }),
    );

    error.mockRestore();
  });

  it("allows tests to opt into in-memory storage explicitly", async () => {
    const app = createTestApiApp();

    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "barestash-api",
    });
  });

  it("keeps non-device API routes available when app origin is not configured", async () => {
    const app = createApiApp();
    const env = {
      DB: {} as D1Database,
      REQUEST_BODIES: {} as R2Bucket,
      ENDPOINT_STREAMS: configuredEndpointStreams,
      BARESTASH_CREDENTIAL_PEPPER: "test-pepper",
      ...configuredRateLimiters,
    };

    const health = await app.fetch(
      new Request("http://localhost/health"),
      env,
      {} as ExecutionContext,
    );
    const deviceAuthorization = await app.fetch(
      new Request("http://localhost/v1/auth/device/authorizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "barestash-cli",
          requested_scopes: ["events:read"],
        }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(health.status).toBe(200);
    expect(deviceAuthorization.status).toBe(503);
    await expect(deviceAuthorization.json()).resolves.toMatchObject({
      error: { code: "device_authorization_unavailable" },
    });
  });

  it.each([
    [
      {
        DB: {} as D1Database,
        REQUEST_BODIES: {} as R2Bucket,
        BARESTASH_CREDENTIAL_PEPPER: "test-pepper",
        BARESTASH_APP_ORIGIN: "https://app.example.com",
        ...configuredRateLimiters,
      },
      "ENDPOINT_STREAMS",
    ],
    [
      {
        DB: {} as D1Database,
        BARESTASH_CREDENTIAL_PEPPER: "test-pepper",
        BARESTASH_APP_ORIGIN: "https://app.example.com",
        ENDPOINT_STREAMS: configuredEndpointStreams,
        ...configuredRateLimiters,
      },
      "REQUEST_BODIES",
    ],
    [
      {
        REQUEST_BODIES: {} as R2Bucket,
        BARESTASH_CREDENTIAL_PEPPER: "test-pepper",
        BARESTASH_APP_ORIGIN: "https://app.example.com",
        ENDPOINT_STREAMS: configuredEndpointStreams,
        ...configuredRateLimiters,
      },
      "DB",
    ],
    [
      {
        DB: {} as D1Database,
        REQUEST_BODIES: {} as R2Bucket,
        BARESTASH_APP_ORIGIN: "https://app.example.com",
        ENDPOINT_STREAMS: configuredEndpointStreams,
        ...configuredRateLimiters,
      },
      "BARESTASH_CREDENTIAL_PEPPER",
    ],
  ])("identifies an individually missing binding", async (env, missing) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApiApp();

    const response = await app.fetch(
      new Request("http://localhost/health"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: `Required runtime bindings are not configured: ${missing}.`,
      },
    });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.configuration.invalid",
        missing_bindings: [missing],
      }),
    );

    error.mockRestore();
  });

  it.each(
    Object.keys(configuredRateLimiters),
  )("fails closed when %s is missing", async (missing) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env: Record<string, unknown> = {
      DB: {} as D1Database,
      REQUEST_BODIES: {} as R2Bucket,
      ENDPOINT_STREAMS: configuredEndpointStreams,
      BARESTASH_CREDENTIAL_PEPPER: "test-pepper",
      BARESTASH_APP_ORIGIN: "https://app.example.com",
      ...configuredRateLimiters,
    };
    delete env[missing];

    const response = await createApiApp().fetch(
      new Request("http://localhost/health"),
      env as never,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: `Required runtime bindings are not configured: ${missing}.`,
      },
    });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.configuration.invalid",
        missing_bindings: [missing],
      }),
    );

    error.mockRestore();
  });

  it("skips scheduled cleanup when persistent bindings are not configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await worker.scheduled?.(
      {
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-07-10T12:00:00.000Z"),
      } as ScheduledController,
      {},
    );

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.cleanup.skipped",
        reason: "persistent_bindings_missing",
      }),
    );

    log.mockRestore();
  });

  it("logs scheduled cleanup counts without raw object keys or sensitive names", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = {
      prepare() {
        return {
          run: async () => ({ meta: { changes: 0 } }),
          bind() {
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({ meta: { changes: 0 } }),
            };
          },
        };
      },
    } as unknown as D1Database;
    const requestBodies = {
      async put() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("not used");
      },
      async delete() {},
      async list() {
        return {
          objects: [],
          delimitedPrefixes: [],
          truncated: false,
        };
      },
    } as unknown as R2Bucket;

    await worker.scheduled?.(
      {
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-07-10T12:00:00.000Z"),
      } as ScheduledController,
      { DB: db, REQUEST_BODIES: requestBodies },
    );

    const message = log.mock.calls.at(-1)?.[0] as string;

    expect(JSON.parse(message)).toEqual({
      event: "barestash.cleanup.completed",
      expired_temporary_endpoints_deleted: 0,
      temporary_events_deleted: 0,
      expired_private_endpoints_deleted: 0,
      expired_private_endpoint_events_deleted: 0,
      private_events_deleted: 0,
      orphan_objects_deleted: 0,
      r2_objects_deleted: 0,
    });
    expect(message).not.toContain("body.raw");
    expect(message).not.toContain("request.json");
    expect(message).not.toContain("authorization");
    expect(message).not.toContain("cookie");
    expect(message).not.toContain("secret");

    log.mockRestore();
  });
});
