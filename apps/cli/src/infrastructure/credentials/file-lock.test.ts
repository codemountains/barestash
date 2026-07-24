import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileCredentialLock } from "./file-lock.js";

vi.unmock("./file-lock.js");

describe("FileCredentialLock", () => {
  it("serializes credential operations across lock instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "barestash-lock-"));
    const path = join(directory, "credentials.lock");
    const first = new FileCredentialLock({ path, retryMilliseconds: 1 });
    const second = new FileCredentialLock({ path, retryMilliseconds: 1 });
    let active = 0;
    let maxActive = 0;
    const operation = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };

    await Promise.all([first.withLock(operation), second.withLock(operation)]);

    expect(maxActive).toBe(1);
  });

  it("releases the lock when an operation throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "barestash-lock-"));
    const lock = new FileCredentialLock({
      path: join(directory, "credentials.lock"),
      retryMilliseconds: 1,
    });
    await expect(
      lock.withLock(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await expect(lock.withLock(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});
