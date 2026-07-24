import { describe, expect, it } from "vitest";

import { FetchApiClient } from "./client.js";

describe("FetchApiClient", () => {
  it("resultFromResponse returns an error for non-ok JSON responses without a second fetch", async () => {
    const fetch = async () =>
      Response.json(
        {
          error: {
            code: "body_not_found",
            message: "Event body not found.",
          },
        },
        {
          status: 404,
        },
      );
    const client = new FetchApiClient(fetch, () => "https://api.example.com");

    const result = await client.resultFromResponse(await fetch());

    expect(result).toEqual({
      kind: "error",
      error: {
        error: {
          code: "body_not_found",
          message: "Event body not found.",
        },
      },
    });
  });

  it("resultFromResponse never returns ok when response.ok is false, even for valid non-error JSON", async () => {
    const response = Response.json({ status: "healthy" }, { status: 500 });
    const client = new FetchApiClient(
      async () => response,
      () => "https://api.example.com",
    );

    const result = await client.resultFromResponse(response);

    expect(result.kind).toBe("error");
  });

  it("refreshes and retries a raw response request once for access_token_expired", async () => {
    const requests: Request[] = [];
    const client = new FetchApiClient(
      async (input, init) => {
        requests.push(new Request(input, init));
        return requests.length === 1
          ? Response.json(
              {
                error: {
                  code: "access_token_expired",
                  message: "Expired.",
                },
              },
              { status: 401 },
            )
          : new Response("event body");
      },
      () => "https://api.example.com",
    );
    client.setAccessTokenExpiredHandler(async () => "new-access");

    const response = await client.requestRaw("/v1/events/evt/body", {
      headers: { authorization: "Bearer old-access" },
    });

    expect(await response.text()).toBe("event body");
    expect(
      requests.map((request) => request.headers.get("authorization")),
    ).toEqual(["Bearer old-access", "Bearer new-access"]);
  });
});
