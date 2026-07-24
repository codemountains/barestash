import type { EventDetail } from "@barestash/shared/events";
import { REDACTED_HEADER_VALUE } from "@barestash/shared/headers";
import { describe, expect, it } from "vitest";
import { makeIo, rawSensitiveEventDetail } from "../../testing/helpers.js";
import {
  printEventDetail,
  printEventHeaders,
  redactEventDetailForDisplay,
} from "./events.js";

describe("event output redaction", () => {
  it("redacts sensitive headers for human detail output", () => {
    const { io, stdout } = makeIo();

    printEventDetail(io, rawSensitiveEventDetail, { ok: true });

    const output = stdout.join("\n");
    expect(output).toContain("authorization: [REDACTED]");
    expect(output).toContain("stripe-signature: [REDACTED]");
    expect(output).not.toContain("Bearer raw-token");
    expect(output).not.toContain("t=raw,v1=raw");
    expect(output).not.toContain("x-barestash-secret");
    expect(output).not.toContain("endpoint-secret");
  });

  it("redacts sensitive headers for human header-only output", () => {
    const { io, stdout } = makeIo();

    printEventHeaders(io, rawSensitiveEventDetail);

    const output = stdout.join("\n");
    expect(output).toContain("authorization: [REDACTED]");
    expect(output).toContain("stripe-signature: [REDACTED]");
    expect(output).not.toContain("Bearer raw-token");
    expect(output).not.toContain("x-barestash-secret");
  });

  it("redacts sensitive headers for JSON display payloads", () => {
    const redacted = redactEventDetailForDisplay(rawSensitiveEventDetail);

    expect(redacted.request.headers).toEqual({
      "content-type": "application/json",
      authorization: REDACTED_HEADER_VALUE,
      "stripe-signature": REDACTED_HEADER_VALUE,
    });
    expect(redacted.request.headers).not.toHaveProperty("x-barestash-secret");
  });

  it("preserves already-redacted headers", () => {
    const event: EventDetail = {
      ...rawSensitiveEventDetail,
      request: {
        ...rawSensitiveEventDetail.request,
        headers: {
          "content-type": "application/json",
          authorization: REDACTED_HEADER_VALUE,
        },
      },
    };

    const redacted = redactEventDetailForDisplay(event);

    expect(redacted.request.headers).toEqual({
      "content-type": "application/json",
      authorization: REDACTED_HEADER_VALUE,
    });
  });
});
