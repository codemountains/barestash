import { describe, expect, it } from "vitest";

import { parseConfig, resolveConfigPath, serializeConfig } from "./config.js";

describe("resolveConfigPath", () => {
  it("prefers BARESTASH_CONFIG_FILE over every platform default", () => {
    expect(
      resolveConfigPath(
        {
          BARESTASH_CONFIG_FILE: "/override/barestash.json",
          XDG_CONFIG_HOME: "/xdg",
          APPDATA: "C:/AppData",
        },
        "win32",
        "/home/tester",
      ),
    ).toBe("/override/barestash.json");
  });

  it("prefers a non-empty XDG_CONFIG_HOME over platform defaults", () => {
    expect(
      resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "darwin", "/Users/tester"),
    ).toBe("/xdg/barestash/config.json");
  });

  it("treats an empty XDG_CONFIG_HOME as unset", () => {
    expect(
      resolveConfigPath({ XDG_CONFIG_HOME: "" }, "darwin", "/Users/tester"),
    ).toBe("/Users/tester/Library/Application Support/barestash/config.json");
  });

  it("uses the macOS application support directory", () => {
    expect(resolveConfigPath({}, "darwin", "/Users/tester")).toBe(
      "/Users/tester/Library/Application Support/barestash/config.json",
    );
  });

  it("uses APPDATA on Windows", () => {
    expect(
      resolveConfigPath(
        { APPDATA: "C:/Users/tester/AppData/Roaming" },
        "win32",
        "C:/Users/tester",
      ),
    ).toBe("C:/Users/tester/AppData/Roaming/barestash/config.json");
  });

  it("falls back to the user profile when APPDATA is unavailable on Windows", () => {
    expect(resolveConfigPath({}, "win32", "C:/Users/tester")).toBe(
      "C:/Users/tester/AppData/Roaming/barestash/config.json",
    );
  });

  it("falls back to the conventional Linux config directory", () => {
    expect(resolveConfigPath({}, "linux", "/home/tester")).toBe(
      "/home/tester/.config/barestash/config.json",
    );
  });
});

describe("config serialization", () => {
  it.each([
    null,
    "",
    "   ",
    "{",
    "null",
    '"not-an-object"',
  ])("parses empty or malformed config as an empty object: %j", (text) => {
    expect(parseConfig(text)).toEqual({});
  });

  it("round trips token and endpoint config with a trailing newline", () => {
    const config = {
      token: "test-token",
      default_endpoint: "ep_test",
    };
    const serialized = serializeConfig(config);

    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseConfig(serialized)).toEqual(config);
  });
});
