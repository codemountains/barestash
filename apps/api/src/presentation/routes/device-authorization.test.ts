import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const DEVICE_CODE = `bst_device_${"d".repeat(32)}`;

describe("Device Authorization routes", () => {
  it("keeps Device Authorization creation unavailable without an app origin", async () => {
    const app = testApp();

    const response = await app.request(
      "/v1/auth/device/authorizations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "barestash-cli",
          requested_scopes: ["events:read"],
        }),
      },
      { BARESTASH_CREDENTIAL_PEPPER: "pepper" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "device_authorization_unavailable",
        message: "Device Authorization is not available.",
      },
    });
  });

  it("creates an authorization through its dedicated rate limit", async () => {
    const createLimiter = allowLimiter();
    const pollLimiter = allowLimiter();
    const app = testApp({ createLimiter, pollLimiter });

    const response = await app.request(
      "/v1/auth/device/authorizations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          client_name: "barestash-cli",
          requested_scopes: ["events:read"],
        }),
      },
      environment(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      device_code: DEVICE_CODE,
      user_code: "ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createLimiter.limit).toHaveBeenCalledWith({
      key: "ip:203.0.113.10",
    });
    expect(pollLimiter.limit).not.toHaveBeenCalled();
  });

  it("rejects unknown scopes without generating a code", async () => {
    const makeDeviceCode = vi.fn(() => DEVICE_CODE);
    const app = testApp({ makeDeviceCode });

    const response = await app.request(
      "/v1/auth/device/authorizations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "barestash-cli",
          requested_scopes: ["unknown:scope"],
        }),
      },
      environment(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(makeDeviceCode).not.toHaveBeenCalled();
  });

  it("polls through a separate limiter and returns structured state errors", async () => {
    const createLimiter = allowLimiter();
    const pollLimiter = allowLimiter();
    const app = testApp({ createLimiter, pollLimiter });
    await app.request(
      "/v1/auth/device/authorizations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "barestash-cli",
          requested_scopes: ["events:read"],
        }),
      },
      environment(),
    );

    const response = await app.request(
      "/v1/auth/device/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.11",
        },
        body: JSON.stringify({ device_code: DEVICE_CODE }),
      },
      environment(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authorization_pending",
        message: "Authorization is still pending.",
      },
    });
    expect(pollLimiter.limit).toHaveBeenCalledWith({
      key: "ip:203.0.113.11",
    });
  });

  it("returns slow_down when valid polling is too frequent", async () => {
    const app = testApp();
    const create = () =>
      app.request(
        "/v1/auth/device/authorizations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "barestash-cli",
            requested_scopes: ["events:read"],
          }),
        },
        environment(),
      );
    await create();
    const poll = () =>
      app.request(
        "/v1/auth/device/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code: DEVICE_CODE }),
        },
        environment(),
      );
    await poll();

    const response = await poll();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "slow_down" },
    });
  });
});

function testApp(
  overrides: {
    createLimiter?: ReturnType<typeof allowLimiter>;
    pollLimiter?: ReturnType<typeof allowLimiter>;
    makeDeviceCode?: () => string;
  } = {},
) {
  return createTestApiApp({
    authDomainRepository: new InMemoryAuthDomainRepository(),
    now: () => NOW,
    generateDeviceAuthorizationId: () => "dva_test",
    generateDeviceCode: overrides.makeDeviceCode ?? (() => DEVICE_CODE),
    generateUserCode: () => "ABCDEFGH",
    rateLimiters: {
      DEVICE_CREATION_RATE_LIMITER: overrides.createLimiter ?? allowLimiter(),
      DEVICE_POLL_RATE_LIMITER: overrides.pollLimiter ?? allowLimiter(),
    },
  });
}

function environment() {
  return {
    BARESTASH_CREDENTIAL_PEPPER: "pepper",
    BARESTASH_APP_ORIGIN: "https://app.example.com",
  };
}

function allowLimiter() {
  return { limit: vi.fn().mockResolvedValue({ success: true }) };
}
