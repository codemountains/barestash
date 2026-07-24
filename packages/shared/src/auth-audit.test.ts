import { describe, expect, it } from "vitest";

import { formatAuthAuditRecord } from "./auth-audit.js";

describe("formatAuthAuditRecord", () => {
  it("serializes only the identifiers allowed for an authentication event", () => {
    const output = formatAuthAuditRecord({
      event: "barestash.auth.access_token.refreshed",
      account_id: "acc_example",
      session_id: "cls_example",
      access_token_id: "atk_example",
      refresh_token_id: "rtk_example",
      access_token: "raw-access-token-marker",
      refresh_token: "raw-refresh-token-marker",
      cookie: "raw-cookie-marker",
    } as never);

    expect(JSON.parse(output)).toEqual({
      event: "barestash.auth.access_token.refreshed",
      account_id: "acc_example",
      session_id: "cls_example",
      access_token_id: "atk_example",
      refresh_token_id: "rtk_example",
    });
    expect(output).not.toContain("raw-access-token-marker");
    expect(output).not.toContain("raw-refresh-token-marker");
    expect(output).not.toContain("raw-cookie-marker");
  });

  it("omits raw device and OAuth codes from browser audit events", () => {
    const output = formatAuthAuditRecord({
      event: "barestash.auth.device_authorization.approved",
      account_id: "acc_example",
      device_authorization_id: "dva_example",
      user_code: "RAW-USER-CODE",
      authorization_code: "raw-oauth-code",
    } as never);

    expect(JSON.parse(output)).toEqual({
      event: "barestash.auth.device_authorization.approved",
      account_id: "acc_example",
      device_authorization_id: "dva_example",
    });
    expect(output).not.toContain("RAW-USER-CODE");
    expect(output).not.toContain("raw-oauth-code");
  });
});
