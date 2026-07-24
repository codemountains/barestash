import { describe, expect, it, vi } from "vitest";
import {
  endpointSecretRowToStoredSecret,
  endpointSecretToMetadata,
  generateEndpointSecret,
} from "./endpoint-secret.js";

describe("endpointSecretToMetadata", () => {
  it("removes stored secret hashes from API metadata", () => {
    expect(
      endpointSecretToMetadata({
        id: "sec_public",
        endpoint_id: "ep_public",
        secret_hash: "hash-only",
        status: "active",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      }),
    ).toEqual({
      id: "sec_public",
      endpoint_id: "ep_public",
      status: "active",
      created_at: "2026-07-05T12:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    });
  });
});

describe("endpointSecretRowToStoredSecret", () => {
  it("maps valid D1 rows to stored endpoint secrets", () => {
    expect(
      endpointSecretRowToStoredSecret({
        id: "sec_row",
        endpoint_id: "ep_row",
        secret_hash: "hash",
        status: "revoked",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: "2026-07-06T12:00:00.000Z",
        revoked_at: "2026-07-07T12:00:00.000Z",
      }),
    ).toEqual({
      id: "sec_row",
      endpoint_id: "ep_row",
      secret_hash: "hash",
      status: "revoked",
      created_at: "2026-07-05T12:00:00.000Z",
      last_used_at: "2026-07-06T12:00:00.000Z",
      revoked_at: "2026-07-07T12:00:00.000Z",
    });
  });

  it("rejects invalid endpoint and secret ids", () => {
    expect(() =>
      endpointSecretRowToStoredSecret({
        id: "not-a-secret",
        endpoint_id: "ep_valid",
        secret_hash: "hash",
        status: "active",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      }),
    ).toThrow("Invalid secret ID");

    expect(() =>
      endpointSecretRowToStoredSecret({
        id: "sec_valid",
        endpoint_id: "not-an-endpoint",
        secret_hash: "hash",
        status: "active",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      }),
    ).toThrow("Invalid endpoint ID");
  });
});

describe("generateEndpointSecret", () => {
  it("generates 32-byte hex endpoint secrets without a public prefix", () => {
    const spy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => {
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength,
        );
        bytes.fill(0xcd);
        return array;
      });

    try {
      expect(generateEndpointSecret()).toBe("cd".repeat(32));
    } finally {
      spy.mockRestore();
    }
  });
});
