import { describe, expect, it } from "vitest";
import {
  MissingRequestBodyStore,
  R2RequestBodyStore,
} from "./request-body-store.js";

describe("MissingRequestBodyStore", () => {
  it("fails deletes so endpoint cleanup remains retryable without the R2 binding", async () => {
    const store = new MissingRequestBodyStore();

    await expect(store.delete("events/ep/body.raw")).rejects.toThrow(
      "REQUEST_BODIES R2 binding is not configured.",
    );
    await expect(store.deleteMany(["events/ep/request.json"])).rejects.toThrow(
      "REQUEST_BODIES R2 binding is not configured.",
    );
  });
});

describe("R2RequestBodyStore", () => {
  it("lists object keys and uploaded timestamps using R2 pagination", async () => {
    const uploaded = new Date("2026-07-10T10:00:00.000Z");
    const listCalls: R2ListOptions[] = [];
    const bucket = {
      async put() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("not used");
      },
      async delete() {},
      async list(options?: R2ListOptions) {
        listCalls.push(options ?? {});

        return {
          objects: [
            {
              key: "events/ep/2026/07/10/evt/body.raw",
              uploaded,
            } as R2Object,
          ],
          delimitedPrefixes: [],
          truncated: true,
          cursor: "next-page",
        };
      },
    } as unknown as R2Bucket;
    const store = new R2RequestBodyStore(bucket);

    await expect(
      store.listObjects({
        prefix: "events/",
        cursor: "cursor-1",
        limit: 25,
      }),
    ).resolves.toEqual({
      objects: [
        {
          key: "events/ep/2026/07/10/evt/body.raw",
          uploaded,
        },
      ],
      truncated: true,
      cursor: "next-page",
    });
    expect(listCalls).toEqual([
      {
        prefix: "events/",
        cursor: "cursor-1",
        limit: 25,
      },
    ]);
  });

  it("stores, reads, deletes, and skips empty bulk deletes", async () => {
    const calls: Array<[string, unknown?]> = [];
    const bucket = {
      async put(key: string, value: Uint8Array | string) {
        calls.push([`put:${key}`, value]);
      },
      async get(key: string) {
        calls.push([`get:${key}`]);
        if (key === "missing") return null;
        return {
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      },
      async delete(keys: string | string[]) {
        calls.push(["delete", keys]);
      },
      async list() {
        throw new Error("not used");
      },
    } as unknown as R2Bucket;
    const store = new R2RequestBodyStore(bucket);

    await store.put("events/body.raw", "body");
    await expect(store.get("events/body.raw")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(store.get("missing")).resolves.toBeNull();
    await store.delete("events/body.raw");
    await store.deleteMany([]);
    await store.deleteMany(["events/request.json", "events/body.raw"]);

    expect(calls).toEqual([
      ["put:events/body.raw", "body"],
      ["get:events/body.raw"],
      ["get:missing"],
      ["delete", "events/body.raw"],
      ["delete", ["events/request.json", "events/body.raw"]],
    ]);
  });
});
