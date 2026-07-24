import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hashCredential,
  timingSafeEqual,
  verifyCredential,
} from "./credential-hash.js";

const TEST_PEPPER = "test-pepper";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("timingSafeEqual", () => {
  it("returns true for equal byte arrays", () => {
    const left = new Uint8Array([1, 2, 3, 4]);
    const right = new Uint8Array([1, 2, 3, 4]);

    expect(timingSafeEqual(left, right)).toBe(true);
  });

  it("returns false for different byte arrays of the same length", () => {
    const left = new Uint8Array([1, 2, 3, 4]);
    const right = new Uint8Array([1, 2, 3, 5]);

    expect(timingSafeEqual(left, right)).toBe(false);
  });

  it("returns false for different-length byte arrays", () => {
    expect(
      timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
    ).toBe(false);
  });
});

describe("hashCredential", () => {
  it("returns a self-describing hmac-sha256 hash string", async () => {
    const stored = await hashCredential("secret-value", {
      pepper: TEST_PEPPER,
    });

    expect(stored).toMatch(/^hmac-sha256\$[0-9a-f]{64}$/);
  });

  it("generates the same stored hash for the same secret and pepper", async () => {
    const first = await hashCredential("secret-value", { pepper: TEST_PEPPER });
    const second = await hashCredential("secret-value", {
      pepper: TEST_PEPPER,
    });

    expect(first).toBe(second);
  });

  it("generates different stored hashes when the pepper differs", async () => {
    const first = await hashCredential("secret-value", { pepper: TEST_PEPPER });
    const second = await hashCredential("secret-value", {
      pepper: "other-pepper",
    });

    expect(first).not.toBe(second);
  });
});

describe("verifyCredential", () => {
  it("accepts secrets that match the stored hash", async () => {
    const stored = await hashCredential("application-secret", {
      pepper: TEST_PEPPER,
    });

    await expect(
      verifyCredential("application-secret", stored, { pepper: TEST_PEPPER }),
    ).resolves.toBe(true);
  });

  it("rejects secrets that do not match the stored hash", async () => {
    const stored = await hashCredential("application-secret", {
      pepper: TEST_PEPPER,
    });

    await expect(
      verifyCredential("wrong-secret", stored, { pepper: TEST_PEPPER }),
    ).resolves.toBe(false);
  });

  it("rejects verification when the pepper differs", async () => {
    const stored = await hashCredential("application-secret", {
      pepper: TEST_PEPPER,
    });

    await expect(
      verifyCredential("application-secret", stored, {
        pepper: "other-pepper",
      }),
    ).resolves.toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    await expect(
      verifyCredential("application-secret", "not-a-valid-hash", {
        pepper: TEST_PEPPER,
      }),
    ).resolves.toBe(false);
  });
});

describe("credential pepper key caching", () => {
  it("imports the key once for repeated hashes and verifies with the same pepper", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const pepper = "repeated-operations-pepper";

    const stored = await hashCredential("application-secret", { pepper });
    await hashCredential("another-secret", { pepper });
    await verifyCredential("application-secret", stored, { pepper });

    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent imports for the same pepper", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const pepper = "concurrent-operations-pepper";

    await Promise.all([
      hashCredential("first-secret", { pepper }),
      hashCredential("second-secret", { pepper }),
      hashCredential("third-secret", { pepper }),
    ]);

    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("imports a new key when the pepper changes", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await hashCredential("application-secret", {
      pepper: "first-cache-pepper",
    });
    await hashCredential("application-secret", {
      pepper: "second-cache-pepper",
    });

    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it("retries the import after a cached import rejects", async () => {
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("import failed"));
    const pepper = "retry-after-failure-pepper";

    await expect(
      hashCredential("application-secret", { pepper }),
    ).rejects.toThrow("import failed");
    await expect(
      hashCredential("application-secret", { pepper }),
    ).resolves.toMatch(/^hmac-sha256\$[0-9a-f]{64}$/);

    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it("does not import a key for a malformed stored hash", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await expect(
      verifyCredential("application-secret", "not-a-valid-hash", {
        pepper: "malformed-hash-pepper",
      }),
    ).resolves.toBe(false);

    expect(importKey).not.toHaveBeenCalled();
  });
});
