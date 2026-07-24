import {
  REDACTED_HEADER_VALUE,
  redactHeadersForDisplay,
} from "@barestash/shared/headers";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { makeIo } from "../testing/helpers.js";

describe("barestash CLI entrypoint", () => {
  it("prints help when no command is provided", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli([], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash {resource} {action}");
  });

  it("prints help for --help", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["--help"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "Resources: auth, endpoints, events, tokens",
    );
  });

  it.each([
    ["--help"],
    ["-h"],
  ])("prints events resource help for events %s", async (helpFlag) => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", helpFlag], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash events");
    expect(stdout.join("\n")).toContain("Follow incoming events");
  });

  it("prints events resource help for events help", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "help"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash events");
    expect(stdout.join("\n")).toContain("Follow incoming events");
  });

  it("prints events subcommand help for events help tail", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "help", "tail"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash events tail");
    expect(stdout.join("\n")).toContain("--poll-interval <duration>");
  });

  it("prints events subcommand help for events help stream", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "help", "stream"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: barestash events stream");
  });

  it("reports extra events help target tokens clearly", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "help", "tail", "stream"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "Unknown command: events help tail stream",
    );
  });

  it("prints the scaffold version", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["--version"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["0.0.0"]);
  });

  it("reports unknown commands clearly", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["unknown"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command: unknown");
    expect(stderr.join("\n")).toContain("Run `barestash --help` for usage.");
  });

  it("rejects events stream without an endpoint selection", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "stream"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("No endpoint selected.");
    expect(stderr.join("\n")).toContain("--endpoint ep_abc123");
  });

  it("can consume shared header display contracts", () => {
    expect(redactHeadersForDisplay({ Authorization: "Bearer raw" })).toEqual({
      authorization: REDACTED_HEADER_VALUE,
    });
  });
});
