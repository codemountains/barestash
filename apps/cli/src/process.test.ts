import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { CliIo } from "./domain/ports.js";
import { runCliProcess } from "./process.js";
import { makeIo } from "./testing/helpers.js";

class FakeProcessSignals extends EventEmitter {
  readonly subscribedSignals: string[] = [];

  override once(
    eventName: string,
    listener: (...args: unknown[]) => void,
  ): this {
    this.subscribedSignals.push(eventName);
    return super.once(eventName, listener);
  }
}

describe("CLI process signals", () => {
  it("treats SIGINT while tail polling as a silent successful exit", async () => {
    const { io, stderr, stdout } = makeIo();
    const signals = new FakeProcessSignals();
    let resolveSleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      resolveSleepStarted = resolve;
    });

    const result = runCliProcess(
      ["events", "tail", "--endpoint", "ep_01JDEF", "--poll-interval", "10s"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => Response.json({ events: [] }),
        sleep: async () => {
          resolveSleepStarted?.();
          await new Promise(() => {});
        },
      },
      signals,
    );

    await sleepStarted;
    signals.emit("SIGINT");

    await expect(result).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toContain("Interrupted");
    expect(signals.subscribedSignals).toEqual(["SIGINT"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("treats SIGINT while tail polling with a leading global flag as a silent successful exit", async () => {
    const { io, stderr, stdout } = makeIo();
    const signals = new FakeProcessSignals();
    let resolveSleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      resolveSleepStarted = resolve;
    });

    const result = runCliProcess(
      [
        "--allow-insecure-api-url",
        "events",
        "tail",
        "--endpoint",
        "ep_01JDEF",
        "--poll-interval",
        "10s",
      ],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => Response.json({ events: [] }),
        sleep: async () => {
          resolveSleepStarted?.();
          await new Promise(() => {});
        },
      },
      signals,
    );

    await sleepStarted;
    signals.emit("SIGINT");

    await expect(result).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toContain("Interrupted");
    expect(signals.subscribedSignals).toEqual(["SIGINT"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("treats SIGINT during an event stream as a silent successful exit", async () => {
    const { io, stderr, stdout } = makeIo();
    const signals = new FakeProcessSignals();
    let resolveFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });

    const result = runCliProcess(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          resolveFetchStarted?.();

          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        },
      },
      signals,
    );

    await fetchStarted;
    signals.emit("SIGINT");

    await expect(result).resolves.toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(signals.subscribedSignals).toEqual(["SIGINT"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("cancels an active SSE body read on SIGINT", async () => {
    const { io, stderr, stdout } = makeIo();
    const signals = new FakeProcessSignals();
    let resolveStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });

    const result = runCliProcess(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () => {
                resolveStreamStarted?.();
                return new Promise(() => {});
              },
              cancel: () => {
                throw new DOMException(
                  "This operation was aborted",
                  "AbortError",
                );
              },
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      },
      signals,
    );

    await streamStarted;
    signals.emit("SIGINT");

    const exitCode = await Promise.race([
      result,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("does not install graceful signal handling for one-shot commands", async () => {
    const signals = new FakeProcessSignals();
    const io: CliIo = {
      stdout: () => {},
      stderr: () => {},
    };

    const result = await runCliProcess(
      ["events", "list", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => Response.json({ events: [] }),
      },
      signals,
    );

    expect(result).toBe(0);
    expect(signals.subscribedSignals).toEqual([]);
  });

  it("preserves failures when a monitoring command was not interrupted", async () => {
    const { io, stderr } = makeIo();
    const signals = new FakeProcessSignals();

    const result = await runCliProcess(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 0,
        fetch: async () => {
          throw new Error("connection failed");
        },
      },
      signals,
    );

    expect(result).toBe(1);
    expect(stderr.join("\n")).toContain("Failed to reach Barestash API.");
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("lets SIGINT win a race with an API error response", async () => {
    const { io, stderr } = makeIo();
    const signals = new FakeProcessSignals();

    const result = await runCliProcess(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => {
          signals.emit("SIGINT");
          return Response.json(
            {
              error: {
                code: "unauthorized",
                message: "Not authenticated.",
              },
            },
            { status: 401 },
          );
        },
      },
      signals,
    );

    expect(result).toBe(0);
    expect(stderr).toEqual([]);
  });
});
