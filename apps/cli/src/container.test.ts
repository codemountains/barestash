import { describe, expect, it, vi } from "vitest";

import { createAppDeps } from "./container.js";
import { InvalidApiBaseUrlError } from "./infrastructure/api/api-url.js";
import { makeIo } from "./testing/helpers.js";

describe("createAppDeps", () => {
  it("rejects dangerous BARESTASH_API_URL values on first fetch", async () => {
    const { io } = makeIo();
    const fetch = vi.fn();
    const deps = createAppDeps(
      io,
      {
        env: {
          BARESTASH_API_URL: "http://169.254.169.254/",
          BARESTASH_TOKEN: "bst_secret",
        },
        fetch,
      },
      { exitCode: 0 },
    );

    await expect(deps.authDeps.apiClient.request("/v1/tokens")).rejects.toThrow(
      InvalidApiBaseUrlError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs the resolved API host on first fetch", async () => {
    const { io, stderr } = makeIo();
    const deps = createAppDeps(
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => Response.json({ tokens: [] }),
        logApiHost: true,
      },
      { exitCode: 0 },
    );

    await deps.authDeps.apiClient.request("/v1/tokens");

    expect(stderr).toEqual(["Barestash API host: api.example.com"]);
  });
});
