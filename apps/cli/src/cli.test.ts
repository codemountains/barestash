import { describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { makeIo } from "./testing/helpers.js";

describe("runCli API URL validation", () => {
  it("rejects dangerous BARESTASH_API_URL values before sending stored tokens", async () => {
    const { io, stderr } = makeIo();
    const fetch = vi.fn();

    const exitCode = await runCli(["auth", "status"], io, {
      env: {
        BARESTASH_API_URL: "http://169.254.169.254/",
        BARESTASH_TOKEN: "bst_secret",
      },
      fetch,
      readConfig: async () => null,
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("private or link-local address");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows private API URLs when --allow-insecure-api-url is set", async () => {
    const { io } = makeIo();

    const exitCode = await runCli(
      ["--allow-insecure-api-url", "auth", "status"],
      io,
      {
        env: {
          BARESTASH_API_URL: "http://192.168.0.10:8787",
          BARESTASH_TOKEN: "bst_secret",
        },
        fetch: async () =>
          Response.json({
            account: { id: "acc_01", primary_email: "user@example.com" },
            credential: {
              type: "personal_access_token",
              id: "tok_01",
              scopes: ["events:read"],
              expires_at: null,
            },
          }),
        readConfig: async () => null,
      },
    );

    expect(exitCode).toBe(0);
  });

  it("allows --help when BARESTASH_API_URL points at a blocked address", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["--help"], io, {
      env: {
        BARESTASH_API_URL: "http://169.254.169.254/",
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "Resources: auth, endpoints, events, tokens",
    );
  });

  it("allows events --help when BARESTASH_API_URL points at a blocked address", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "--help"], io, {
      env: {
        BARESTASH_API_URL: "http://169.254.169.254/",
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash events");
  });

  it("allows --help when BARESTASH_API_URL is not a valid URL", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["--help"], io, {
      env: {
        BARESTASH_API_URL: "not-a-url",
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "Resources: auth, endpoints, events, tokens",
    );
  });
});
