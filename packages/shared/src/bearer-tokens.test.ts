import { describe, expect, it } from "vitest";

import {
  formatBearerTokenString,
  formatPatBearerTokenString,
  generateBearerTokenSecret,
  parseBearerTokenString,
  tokenIdFromBearerTokenString,
} from "./bearer-tokens.js";
import {
  generateTokenId,
  TOKEN_ID_SUFFIX_LENGTH,
  type TokenId,
} from "./ids.js";

function testTokenId(label: string): TokenId {
  const alphanumeric = label.replace(/[^A-Za-z0-9]/g, "");
  const suffix = (alphanumeric + "0".repeat(TOKEN_ID_SUFFIX_LENGTH)).slice(
    0,
    TOKEN_ID_SUFFIX_LENGTH,
  );

  return `tok_${suffix}` as TokenId;
}

describe("bearer token strings", () => {
  it("round trips PAT bearer token parse and reconstruction", () => {
    const tokenId = generateTokenId({
      randomBytes: Uint8Array.from({ length: 24 }, (_, index) => index + 1),
    });
    const secret = generateBearerTokenSecret({
      randomBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 33),
    });
    const bearer = formatPatBearerTokenString(tokenId, secret);

    const parsed = parseBearerTokenString(bearer);

    expect(parsed).toEqual({
      type: "pat",
      tokenIdSuffix: tokenId.slice("tok_".length),
      secret,
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected parsed bearer token");
    }
    expect(formatBearerTokenString(parsed)).toBe(bearer);
    expect(tokenIdFromBearerTokenString(bearer)).toBe(tokenId);
  });

  it("rejects bearer strings when token-id or secret contain underscores", () => {
    const tokenId = testTokenId("ambiguous");
    const secret = generateBearerTokenSecret({
      randomBytes: Uint8Array.from({ length: 32 }, () => 10),
    });
    const validBearer = formatPatBearerTokenString(tokenId, secret);

    expect(
      parseBearerTokenString(validBearer.replace("pat", "pat_bad")),
    ).toBeNull();
    expect(
      parseBearerTokenString(
        validBearer.replace(
          tokenId.slice("tok_".length),
          "has_underscore_in_id",
        ),
      ),
    ).toBeNull();
    expect(
      parseBearerTokenString(validBearer.replace(secret, `${secret}_extra`)),
    ).toBeNull();
  });

  it("rejects bearer strings with invalid segment lengths", () => {
    expect(parseBearerTokenString("bst_pat_short_secret")).toBeNull();
    expect(parseBearerTokenString("bst_pat_")).toBeNull();
    expect(parseBearerTokenString("bst_access_only_two_parts")).toBeNull();
  });
});
