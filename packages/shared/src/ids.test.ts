import { describe, expect, it } from "vitest";

import {
  generateAccessTokenId,
  generateAccountId,
  generateBrowserAccountMappingId,
  generateCliSessionId,
  generateDeviceAuthorizationId,
  generateEndpointId,
  generateEventId,
  generateIdentityId,
  generatePatIdempotencyId,
  generateRefreshTokenId,
  generateSecretId,
  generateTokenId,
  ID_PREFIXES,
  isAccessTokenId,
  isAccountId,
  isCliSessionId,
  isEndpointId,
  isEventId,
  isRefreshTokenId,
  isSecretId,
  isStoredTokenId,
  isTokenId,
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

const LEGACY_TOKEN_ID = `tok_${"A".repeat(22)}_-` as const;

describe("ID helpers", () => {
  it("generates IDs with the shared prefixes", () => {
    expect(generateAccountId()).toMatch(/^acc_/);
    expect(generateIdentityId()).toMatch(/^idn_/);
    expect(generateBrowserAccountMappingId()).toMatch(/^bam_/);
    expect(generateDeviceAuthorizationId()).toMatch(/^dva_/);
    expect(generateCliSessionId()).toMatch(/^cls_/);
    expect(generateAccessTokenId()).toMatch(/^atk_[A-Za-z0-9]{24}$/);
    expect(generateRefreshTokenId()).toMatch(/^rtk_[A-Za-z0-9]{24}$/);
    expect(generatePatIdempotencyId()).toMatch(/^pid_/);
    expect(generateEndpointId()).toMatch(/^ep_/);
    expect(generateEventId()).toMatch(/^evt_/);
    expect(generateTokenId()).toMatch(/^tok_[A-Za-z0-9]{24}$/);
    expect(generateSecretId()).toMatch(/^sec_/);
  });

  it("never emits underscores or hyphens in generated token id suffixes", () => {
    const randomBytes = new Uint8Array(24);

    for (let index = 0; index < 24; index += 1) {
      randomBytes[index] = 62 + (index % 2);
    }

    const tokenId = generateTokenId({ randomBytes });

    expect(tokenId).toMatch(/^tok_[A-Za-z0-9]{24}$/);
    expect(tokenId.slice("tok_".length)).not.toMatch(/[_-]/);
  });

  it("rejects short caller-provided random byte arrays", () => {
    expect(() =>
      generateEndpointId({ randomBytes: new Uint8Array(15) }),
    ).toThrow("at least 16 bytes");
    expect(() => generateTokenId({ randomBytes: new Uint8Array(23) })).toThrow(
      "at least 24 bytes",
    );
  });

  it("recognizes IDs by prefix", () => {
    expect(ID_PREFIXES).toEqual({
      accessToken: "atk_",
      account: "acc_",
      browserAccountMapping: "bam_",
      cliSession: "cls_",
      deviceAuthorization: "dva_",
      endpoint: "ep_",
      event: "evt_",
      identity: "idn_",
      patIdempotency: "pid_",
      refreshToken: "rtk_",
      secret: "sec_",
      token: "tok_",
    });

    expect(isEndpointId("ep_abc123")).toBe(true);
    expect(isEventId("evt_abc123")).toBe(true);
    expect(isTokenId(testTokenId("abc123"))).toBe(true);
    expect(isSecretId("sec_abc123")).toBe(true);
    expect(isEndpointId("evt_abc123")).toBe(false);
    expect(isAccountId("acc_abc123")).toBe(true);
    expect(isCliSessionId("cls_abc123")).toBe(true);
    expect(isAccessTokenId(`atk_${"A".repeat(24)}`)).toBe(true);
    expect(isAccessTokenId("atk_short")).toBe(false);
    expect(isRefreshTokenId(`rtk_${"A".repeat(24)}`)).toBe(true);
    expect(isRefreshTokenId(`rtk_${"A".repeat(22)}_-`)).toBe(false);
    expect(isEventId("evt_")).toBe(false);
    expect(isTokenId("tok_abc123")).toBe(false);
    expect(isTokenId("tok_short")).toBe(false);
    expect(isTokenId(LEGACY_TOKEN_ID)).toBe(false);
    expect(isStoredTokenId(LEGACY_TOKEN_ID)).toBe(true);
    expect(isStoredTokenId(testTokenId("abc123"))).toBe(true);
    expect(isStoredTokenId("tok_short")).toBe(false);
  });
});
