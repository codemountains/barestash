import { describe, expect, it } from "vitest";

import { parseTokenDurationSeconds } from "./duration.js";

describe("parseTokenDurationSeconds", () => {
  it.each([
    ["30d", 2_592_000],
    ["90d", 7_776_000],
    ["1y", 31_536_000],
  ])("converts %s to API seconds", (input, expected) => {
    expect(parseTokenDurationSeconds(input)).toBe(expected);
  });

  it("rejects unsupported or zero durations", () => {
    expect(() => parseTokenDurationSeconds("0d")).toThrow(
      "Token expiration must be a positive duration",
    );
    expect(() => parseTokenDurationSeconds("90days")).toThrow(
      "Token expiration must include a unit: d or y",
    );
  });
});
