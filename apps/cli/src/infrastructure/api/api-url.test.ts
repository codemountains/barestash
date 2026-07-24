import { describe, expect, it } from "vitest";

import {
  InvalidApiBaseUrlError,
  resolveApiBaseUrl,
  validateApiBaseUrl,
} from "./api-url.js";

describe("validateApiBaseUrl", () => {
  it("accepts the default local development URL", () => {
    expect(validateApiBaseUrl("http://localhost:8787")).toEqual({
      ok: true,
      url: new URL("http://localhost:8787"),
    });
  });

  it("accepts public https API hosts", () => {
    expect(validateApiBaseUrl("https://api.example.com")).toEqual({
      ok: true,
      url: new URL("https://api.example.com"),
    });
  });

  it("rejects unsupported URL schemes", () => {
    expect(validateApiBaseUrl("file:///etc/passwd")).toEqual({
      ok: false,
      message: "BARESTASH_API_URL must use the http: or https: scheme.",
    });
  });

  it("rejects URLs with embedded credentials", () => {
    expect(validateApiBaseUrl("https://token:secret@api.example.com")).toEqual({
      ok: false,
      message: "BARESTASH_API_URL must not include embedded credentials.",
    });
  });

  it("rejects RFC1918 private IPv4 addresses by default", () => {
    expect(validateApiBaseUrl("http://192.168.1.10:8787")).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });

  it("rejects cloud metadata link-local addresses by default", () => {
    expect(
      validateApiBaseUrl("http://169.254.169.254/latest/meta-data/"),
    ).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });

  it("allows private addresses when explicitly permitted", () => {
    expect(
      validateApiBaseUrl("http://192.168.1.10:8787", {
        allowInsecure: true,
      }),
    ).toEqual({
      ok: true,
      url: new URL("http://192.168.1.10:8787"),
    });
  });

  it("rejects link-local IPv6 addresses by default", () => {
    expect(validateApiBaseUrl("http://[fe80::1]/")).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });

  it("rejects cloud metadata via IPv4-mapped IPv6 addresses by default", () => {
    expect(validateApiBaseUrl("http://[::ffff:169.254.169.254]/")).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });

  it("rejects metadata hostnames with a trailing dot", () => {
    expect(validateApiBaseUrl("http://metadata.google.internal./")).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });

  it("rejects the full IPv6 link-local range", () => {
    expect(validateApiBaseUrl("http://[fe90::1]/")).toEqual({
      ok: false,
      message:
        "BARESTASH_API_URL points to a private or link-local address. Use --allow-insecure-api-url to override.",
    });
  });
});

describe("resolveApiBaseUrl", () => {
  it("throws InvalidApiBaseUrlError for dangerous URLs", () => {
    expect(() => resolveApiBaseUrl("http://169.254.169.254/")).toThrow(
      InvalidApiBaseUrlError,
    );
  });
});
