import { describe, expect, it } from "vitest";

import {
  createDeviceContinuation,
  readDeviceContinuation,
} from "./device-continuation.js";

const SECRET = "s".repeat(32);

describe("Device OAuth continuation", () => {
  it("encrypts the user code and binds it to authorization expiry", async () => {
    const token = await createDeviceContinuation({
      secret: SECRET,
      authorizationId: "dva_test",
      userCode: "ABCDEFGH",
      expiresAt: "2026-07-13T00:10:00.000Z",
      randomBytes: new Uint8Array(12).fill(7),
    });

    expect(token).not.toContain("ABCDEFGH");
    await expect(
      readDeviceContinuation(token, {
        secret: SECRET,
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toEqual({
      authorizationId: "dva_test",
      userCode: "ABCDEFGH",
      expiresAt: "2026-07-13T00:10:00.000Z",
    });
  });

  it("rejects the wrong key, tampering, and expiry", async () => {
    const token = await createDeviceContinuation({
      secret: SECRET,
      authorizationId: "dva_test",
      userCode: "ABCDEFGH",
      expiresAt: "2026-07-13T00:10:00.000Z",
      randomBytes: new Uint8Array(12).fill(7),
    });

    await expect(
      readDeviceContinuation(token, {
        secret: "x".repeat(32),
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBeNull();
    await expect(
      readDeviceContinuation(`${token}x`, {
        secret: SECRET,
        now: new Date("2026-07-13T00:05:00.000Z"),
      }),
    ).resolves.toBeNull();
    await expect(
      readDeviceContinuation(token, {
        secret: SECRET,
        now: new Date("2026-07-13T00:10:00.000Z"),
      }),
    ).resolves.toBeNull();
  });
});
