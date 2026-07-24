import { describe, expect, it, vi } from "vitest";

import { createSecureFetch } from "./secure-fetch.js";

describe("createSecureFetch", () => {
  it("does not follow redirects to private addresses", async () => {
    const fetch = vi.fn(async () =>
      Response.redirect("http://169.254.169.254/latest/meta-data/", 302),
    );
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    await expect(
      secureFetch("https://api.example.com/v1/tokens"),
    ).rejects.toThrow(
      "Redirect target points to a private or link-local address.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/tokens",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("does not send authorization to cross-origin redirect targets", async () => {
    const fetch = vi.fn(async () =>
      Response.redirect("https://attacker.example.com/steal", 302),
    );
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    await expect(
      secureFetch("https://api.example.com/v1/tokens", {
        headers: {
          authorization: "Bearer secret",
        },
      }),
    ).rejects.toThrow(
      "Barestash API redirect to a different origin is not allowed.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/tokens",
      expect.objectContaining({
        headers: {
          authorization: "Bearer secret",
        },
        redirect: "manual",
      }),
    );
  });

  it("follows a safe redirect and reuses redirect manual for each hop", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect("https://api.example.com/v2/tokens", 307),
      )
      .mockResolvedValueOnce(Response.json({ tokens: [] }));
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    const response = await secureFetch("https://api.example.com/v1/tokens");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.example.com/v2/tokens");
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects redirect chains that exceed the cap", async () => {
    const fetch = vi.fn(async () =>
      Response.redirect("https://api.example.com/next", 302),
    );
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
      maxRedirects: 1,
    });

    await expect(secureFetch("https://api.example.com/start")).rejects.toThrow(
      "Barestash API redirect limit exceeded.",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rewrites POST to GET for 302 redirects", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect("https://api.example.com/v2/tokens", 302),
      )
      .mockResolvedValueOnce(Response.json({ tokens: [] }));
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    await secureFetch("https://api.example.com/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "ci" }),
    });

    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        body: undefined,
        redirect: "manual",
      }),
    );
  });

  it("preserves DELETE for 302 redirects", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect("https://api.example.com/v2/tokens/tok_01", 302),
      )
      .mockResolvedValueOnce(Response.json({ token: { id: "tok_01" } }));
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    await secureFetch("https://api.example.com/v1/tokens/tok_01", {
      method: "DELETE",
    });

    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "DELETE",
        redirect: "manual",
      }),
    );
  });

  it("preserves POST bodies for 307 redirects", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect("https://api.example.com/v2/tokens", 307),
      )
      .mockResolvedValueOnce(Response.json({ token: { id: "tok_01" } }));
    const secureFetch = createSecureFetch(fetch, {
      allowInsecure: false,
    });

    await secureFetch("https://api.example.com/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "ci" }),
    });

    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "ci" }),
        redirect: "manual",
      }),
    );
  });
});
