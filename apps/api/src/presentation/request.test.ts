import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import { describe, expect, it } from "vitest";

import {
  readCreateEndpointRequest,
  readCreateTokenRequest,
} from "./request.js";

describe.each([
  ["endpoint", readCreateEndpointRequest],
  ["token", readCreateTokenRequest],
] as const)("%s create request reader", (requestType, readRequest) => {
  it("accepts an omitted body without a JSON content type", async () => {
    const request = new Request("https://api.example.com/v1/resource", {
      method: "POST",
    });

    await expect(readRequest(request)).resolves.toEqual(
      requestType === "token" ? { scopes: AUTHORIZATION_SCOPES } : {},
    );
  });

  it("accepts an empty JSON object", async () => {
    const request = new Request("https://api.example.com/v1/resource", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    await expect(readRequest(request)).resolves.toEqual(
      requestType === "token" ? { scopes: AUTHORIZATION_SCOPES } : {},
    );
  });
});
