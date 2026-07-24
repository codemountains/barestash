import { describe, expect, it } from "vitest";

import { createDeviceCsrfToken, verifyDeviceCsrfToken } from "./device-csrf.js";

const SECRET = "s".repeat(32);
const EXPIRES_AT = "2026-07-13T00:10:00.000Z";

describe("Device approval CSRF tokens", () => {
  it("binds the signature to session, authorization, and expiry", async () => {
    const token = await createDeviceCsrfToken({
      secret: SECRET,
      sessionId: "session-one",
      authorizationId: "dva_one",
      expiresAt: EXPIRES_AT,
    });

    await expect(
      verifyDeviceCsrfToken(token, {
        secret: SECRET,
        sessionId: "session-one",
        authorizationId: "dva_one",
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBe(true);
    await expect(
      verifyDeviceCsrfToken(token, {
        secret: SECRET,
        sessionId: "session-two",
        authorizationId: "dva_one",
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDeviceCsrfToken(token, {
        secret: SECRET,
        sessionId: "session-one",
        authorizationId: "dva_two",
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBe(false);
  });

  it("rejects tampering and expiry", async () => {
    const token = await createDeviceCsrfToken({
      secret: SECRET,
      sessionId: "session-one",
      authorizationId: "dva_one",
      expiresAt: EXPIRES_AT,
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(
      verifyDeviceCsrfToken(tampered, {
        secret: SECRET,
        sessionId: "session-one",
        authorizationId: "dva_one",
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDeviceCsrfToken(token, {
        secret: SECRET,
        sessionId: "session-one",
        authorizationId: "dva_one",
        now: new Date(EXPIRES_AT),
      }),
    ).resolves.toBe(false);
  });
});
