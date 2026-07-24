import { describe, expect, it, vi } from "vitest";

import { CompensationStack } from "./compensation.js";

describe("CompensationStack", () => {
  it("runs registered compensations once in reverse order", async () => {
    const calls: string[] = [];
    const compensations = new CompensationStack();

    compensations.add(async () => {
      calls.push("release capacity");
    });
    compensations.add(async () => {
      calls.push("delete body");
      throw new Error("best-effort cleanup failed");
    });
    compensations.add(async () => {
      calls.push("delete envelope");
    });

    await compensations.run();
    await compensations.run();

    expect(calls).toEqual([
      "delete envelope",
      "delete body",
      "release capacity",
    ]);
  });

  it("can be cleared after the transaction commits", async () => {
    const compensate = vi.fn();
    const compensations = new CompensationStack();

    compensations.add(compensate);
    compensations.clear();
    await compensations.run();

    expect(compensate).not.toHaveBeenCalled();
  });
});
