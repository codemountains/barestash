import { describe, expect, it, vi } from "vitest";
import { testTokenId } from "../testing/helpers.js";
import { generateTokenSecret } from "./token.js";

describe("generateTokenSecret", () => {
  it("generates PAT bearer token strings with embedded token ids", () => {
    const tokenId = testTokenId("pat");
    const spy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => {
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength,
        );
        bytes.fill(0xab);
        return array;
      });

    try {
      expect(generateTokenSecret(tokenId)).toMatch(
        new RegExp(`^bst_pat_${tokenId.slice("tok_".length)}_[A-Za-z0-9]{32}$`),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
