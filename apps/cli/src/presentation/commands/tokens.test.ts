import { describe, expect, it } from "vitest";

import { runCli } from "../../cli.js";
import { makeIo } from "../../testing/helpers.js";

describe("token commands", () => {
  it("does not forward a removed bootstrap credential", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["tokens", "create", "--name", "ci-github"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_BOOTSTRAP_TOKEN: "bootstrap-secret",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return Response.json(
            {
              id: "tok_ci",
              name: "ci-github",
              token: "bst_created_secret",
              status: "active",
              scopes: [
                "endpoints:read",
                "endpoints:write",
                "events:read",
                "tokens:read",
                "tokens:write",
                "mcp:use",
              ],
              created_at: "2026-07-05T12:00:00.000Z",
              expires_at: "2026-10-03T12:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
            {
              status: 201,
            },
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([
      "Scopes: endpoints:read endpoints:write events:read tokens:read tokens:write mcp:use",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.example.com/v1/tokens");
    expect(requests[0].headers.get("x-barestash-bootstrap-token")).toBeNull();
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[0].headers.get("idempotency-key")).not.toBeNull();
    expect(await requests[0].json()).toEqual({
      name: "ci-github",
      scopes: [
        "endpoints:read",
        "endpoints:write",
        "events:read",
        "tokens:read",
        "tokens:write",
        "mcp:use",
      ],
    });
    expect(stdout.join("\n")).toContain("Created token: tok_ci");
    expect(stdout.join("\n")).toContain("bst_created_secret");
  });
});
