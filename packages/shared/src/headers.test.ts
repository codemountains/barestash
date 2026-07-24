import { describe, expect, it } from "vitest";

import {
  BARESTASH_SECRET_HEADER,
  filterPersistedHeaders,
  filterRawRequestHeaders,
  isPersistedHeader,
  isSensitiveHeader,
  REDACTED_HEADER_VALUE,
  redactHeadersForDisplay,
} from "./headers.js";

describe("header safety helpers", () => {
  const headers = {
    Authorization: "Bearer raw-token",
    "Content-Type": "application/json",
    "Stripe-Signature": "t=raw,v1=raw",
    "User-Agent": "Stripe/1.0",
    "X-Barestash-Bootstrap-Token": "bootstrap-secret",
    "X-Barestash-Secret": "endpoint-secret",
    "X-Custom": "kept for display",
  };

  it("stores only allowlisted headers for D1 metadata", () => {
    expect(filterPersistedHeaders(headers)).toEqual({
      "content-type": "application/json",
      "user-agent": "Stripe/1.0",
    });
  });

  it("excludes Barestash credentials from raw request envelopes", () => {
    expect(filterRawRequestHeaders(headers)).toEqual({
      authorization: "Bearer raw-token",
      "content-type": "application/json",
      "stripe-signature": "t=raw,v1=raw",
      "user-agent": "Stripe/1.0",
      "x-custom": "kept for display",
    });
  });

  it("redacts sensitive headers for API and CLI display", () => {
    expect(redactHeadersForDisplay(headers)).toEqual({
      authorization: REDACTED_HEADER_VALUE,
      "content-type": "application/json",
      "stripe-signature": REDACTED_HEADER_VALUE,
      "user-agent": "Stripe/1.0",
      "x-custom": "kept for display",
    });
  });

  it("classifies header policy names", () => {
    expect(BARESTASH_SECRET_HEADER).toBe("x-barestash-secret");
    expect(isPersistedHeader("Content-Type")).toBe(true);
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("X-Barestash-Bootstrap-Token")).toBe(true);
    expect(isSensitiveHeader("X-Custom")).toBe(false);
  });
});
