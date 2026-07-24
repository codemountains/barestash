import { describe, expect, it } from "vitest";

import { createRestErrorResponse } from "./errors.js";

describe("REST error contracts", () => {
  it("creates the shared REST error response shape", () => {
    expect(
      createRestErrorResponse(
        "payload_too_large",
        "Request body exceeds the 10MB limit.",
      ),
    ).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body exceeds the 10MB limit.",
      },
    });
  });

  it("includes the documented temporary endpoint delete error code", () => {
    expect(
      createRestErrorResponse(
        "temporary_endpoint_delete_not_supported",
        "Temporary endpoint deletion is not supported in MVP.",
      ),
    ).toEqual({
      error: {
        code: "temporary_endpoint_delete_not_supported",
        message: "Temporary endpoint deletion is not supported in MVP.",
      },
    });
  });

  it("includes the endpoint event limit error code", () => {
    expect(
      createRestErrorResponse(
        "event_limit_exceeded",
        "Endpoint has reached the configured event limit.",
      ),
    ).toEqual({
      error: {
        code: "event_limit_exceeded",
        message: "Endpoint has reached the configured event limit.",
      },
    });
  });

  it.each([
    "rate_limit_exceeded",
    "rate_limit_unavailable",
  ] as const)("includes the %s error code", (code) => {
    expect(createRestErrorResponse(code, "Rate limit response.")).toEqual({
      error: {
        code,
        message: "Rate limit response.",
      },
    });
  });

  it.each([
    "authorization_pending",
    "authorization_denied",
    "device_code_expired",
    "device_code_consumed",
    "invalid_device_code",
    "invalid_user_code",
    "slow_down",
    "invalid_token",
    "access_token_expired",
    "token_revoked",
    "personal_access_token_expired",
    "insufficient_scope",
    "refresh_token_expired",
    "refresh_token_revoked",
    "refresh_token_reuse_detected",
    "session_expired",
    "session_revoked",
    "account_disabled",
    "idempotency_key_required",
    "idempotency_key_conflict",
  ] as const)("supports structured authentication error %s", (code) => {
    expect(createRestErrorResponse(code, "auth failure")).toEqual({
      error: { code, message: "auth failure" },
    });
  });
});
