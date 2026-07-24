import { describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  clientIpRateLimitKey,
  type RateLimitBinding,
} from "./rate-limit.js";

class StubRateLimiter implements RateLimitBinding {
  readonly keys: string[] = [];

  constructor(private readonly result: { success: boolean } | Error) {}

  async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);

    if (this.result instanceof Error) {
      throw this.result;
    }

    return this.result;
  }
}

describe("rate limiting", () => {
  it("uses only CF-Connecting-IP and falls back to a shared unknown actor", () => {
    expect(
      clientIpRateLimitKey(
        new Request("https://api.example.com", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": "198.51.100.2",
          },
        }),
      ),
    ).toBe("ip:203.0.113.7");

    expect(
      clientIpRateLimitKey(
        new Request("https://api.example.com", {
          headers: { "x-forwarded-for": "198.51.100.2" },
        }),
      ),
    ).toBe("ip:unknown");
  });

  it("returns typed errors and emits logs without actor keys", async () => {
    const limitedLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const failedLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const limited = new StubRateLimiter({ success: false });
    const unavailable = new StubRateLimiter(new Error("credential=value"));

    await expect(
      checkRateLimit({
        limiter: limited,
        key: "token:sensitive-fingerprint",
        surface: "mcp",
        method: "POST",
        path: "/mcp",
      }),
    ).resolves.toEqual({
      kind: "error",
      code: "rate_limit_exceeded",
      message: "Too many requests.",
      status: 429,
    });
    await expect(
      checkRateLimit({
        limiter: unavailable,
        key: "ip:203.0.113.7",
        surface: "ingest_ip",
        method: "POST",
        path: "/ep_example",
      }),
    ).resolves.toEqual({
      kind: "error",
      code: "rate_limit_unavailable",
      message:
        "Request cannot be processed because abuse protection is unavailable.",
      status: 503,
    });

    const messages = [...limitedLog.mock.calls, ...failedLog.mock.calls]
      .flat()
      .join("\n");
    expect(messages).toContain("barestash.rate_limit.exceeded");
    expect(messages).toContain("barestash.rate_limit.failed");
    expect(messages).not.toContain("sensitive-fingerprint");
    expect(messages).not.toContain("203.0.113.7");
    expect(messages).not.toContain("credential=value");

    limitedLog.mockRestore();
    failedLog.mockRestore();
  });
});
