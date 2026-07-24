import { createRestErrorResponse } from "@barestash/shared/errors";
import { describe, expect, it } from "vitest";
import { makeApp } from "../../testing/helpers.js";

describe("API health routes", () => {
  it("returns a minimal public health response", async () => {
    const app = makeApp();
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "barestash-api",
    });
  });

  it("returns a versioned development health response", async () => {
    const app = makeApp();
    const response = await app.request("http://localhost/v1/dev/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "barestash-api",
      version: "v1",
    });
  });

  it("can consume shared REST error contracts", () => {
    expect(
      createRestErrorResponse(
        "internal_error",
        "An unexpected error occurred.",
      ),
    ).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
  });
});
