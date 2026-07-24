import { describe, expect, it } from "vitest";

import {
  type AccountResponse,
  AUTHORIZATION_SCOPES,
  type AuthPrincipal,
  type DeviceAuthorizationCreateResponse,
  type DeviceTokenResponse,
} from "./auth.js";
import type {
  EndpointSecretCreateResponse,
  EndpointSecretListResponse,
} from "./endpoint-secrets.js";
import type { EndpointMetadata } from "./endpoints.js";
import type { EventMetadata, EventStreamPayload } from "./events.js";
import {
  PRIVATE_ENDPOINT_EVENT_LIMIT,
  PRIVATE_ENDPOINT_TTL_SECONDS,
  TEMPORARY_ENDPOINT_EVENT_LIMIT,
  TEMPORARY_ENDPOINT_TTL_SECONDS,
} from "./limits.js";
import type {
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenListResponse,
} from "./personal-access-tokens.js";

describe("authentication contracts", () => {
  it("defines the complete MVP scope set and a secret-free principal", () => {
    expect(AUTHORIZATION_SCOPES).toEqual([
      "endpoints:read",
      "endpoints:write",
      "events:read",
      "tokens:read",
      "tokens:write",
      "mcp:use",
    ]);

    const principal = {
      accountId: "acc_example",
      credential: {
        type: "personal_access_token",
        id: "tok_example",
        scopes: ["events:read"],
        expiresAt: null,
      },
    } satisfies AuthPrincipal;

    expect(JSON.stringify(principal)).not.toContain("secret");
  });

  it("covers account, device, session, access, refresh, and PAT API flows", () => {
    const deviceAuthorization = {
      device_code: "bst_device_example",
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.example.com/device",
      verification_uri_complete:
        "https://app.example.com/device?code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    } satisfies DeviceAuthorizationCreateResponse;
    const deviceToken = {
      access_token: "bst_access_example",
      refresh_token: "bst_refresh_example",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 7_776_000,
      scopes: ["events:read"],
    } satisfies DeviceTokenResponse;
    const account = {
      account: {
        id: "acc_example",
        primary_email: "user@example.com",
      },
      credential: {
        type: "cli_access_token",
        id: "atk_example",
        session_id: "cls_example",
        scopes: deviceToken.scopes,
        expires_at: "2026-07-12T13:00:00.000Z",
      },
    } satisfies AccountResponse;

    expect(deviceAuthorization.interval).toBe(5);
    expect(account.credential.type).toBe("cli_access_token");
  });
});

describe("event contracts", () => {
  it("supports shared event metadata and stream payload shapes", () => {
    const metadata = {
      id: "evt_01JDEF",
      endpoint_id: "ep_01JABC",
      received_at: "2026-07-05T12:04:32.000Z",
      method: "POST",
      request_path: "/webhook/stripe",
      query: {},
      headers: {
        "content-type": "application/json",
      },
      body: {
        size: 8400,
        sha256: "hash",
        available: true,
      },
    } satisfies EventMetadata;

    const payload = {
      id: metadata.id,
      endpoint_id: metadata.endpoint_id,
      received_at: metadata.received_at,
      request: {
        method: metadata.method,
        path: metadata.request_path,
        query: metadata.query,
        headers: metadata.headers,
        body_size: metadata.body.size,
        body_sha256: metadata.body.sha256,
      },
      body: {
        encoding: "base64",
        data: "e30=",
      },
    } satisfies EventStreamPayload;

    expect(payload.body.encoding).toBe("base64");
  });
});

describe("endpoint contracts", () => {
  it("supports temporary endpoint metadata with MVP constraints", () => {
    const endpoint = {
      id: "ep_01JDEF",
      name: "stripe-test",
      mode: "temporary",
      status: "active",
      public_read: true,
      event_count: 0,
      event_limit: TEMPORARY_ENDPOINT_EVENT_LIMIT,
      expires_at: "2026-07-06T12:00:00.000Z",
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:00:00.000Z",
      ingest_url: "https://ingest.example.com/ep_01JDEF",
    } satisfies EndpointMetadata;

    expect(TEMPORARY_ENDPOINT_TTL_SECONDS).toBe(24 * 60 * 60);
    expect(endpoint.mode).toBe("temporary");
    expect(endpoint.public_read).toBe(true);
    expect(endpoint.event_limit).toBe(100);
  });

  it("supports private endpoint metadata with seven-day TTL and event limit", () => {
    const endpoint = {
      id: "ep_private",
      name: "github-dev",
      mode: "private",
      status: "active",
      public_read: false,
      event_count: 0,
      event_limit: PRIVATE_ENDPOINT_EVENT_LIMIT,
      expires_at: "2026-07-12T12:00:00.000Z",
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:00:00.000Z",
      ingest_url: "https://ingest.example.com/ep_private",
    } satisfies EndpointMetadata;

    expect(PRIVATE_ENDPOINT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(endpoint.mode).toBe("private");
    expect(endpoint.public_read).toBe(false);
    expect(endpoint.event_limit).toBe(1000);
  });

  it("supports one-time endpoint secret creation and secret-free list responses", () => {
    const created = {
      endpoint_secret: {
        id: "sec_abc123",
        endpoint_id: "ep_01JDEF",
        status: "active",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      },
      secret: "endpoint-secret",
    } satisfies EndpointSecretCreateResponse;
    const listed = {
      endpoint_secrets: [created.endpoint_secret],
    } satisfies EndpointSecretListResponse;

    expect(created.endpoint_secret.id).toMatch(/^sec_/);
    expect(JSON.stringify(listed)).not.toContain("endpoint-secret");
  });
});

describe("personal access token contracts", () => {
  it("supports one-time token creation responses and secret-free list responses", () => {
    const created = {
      id: "tok_abc123",
      name: "ci-github",
      status: "active",
      scopes: ["events:read"],
      created_at: "2026-07-05T12:00:00.000Z",
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      token: "bst_example",
    } satisfies PersonalAccessTokenCreateResponse;
    const { token: oneTimeToken, ...metadata } = created;
    const listed = {
      tokens: [metadata],
    } satisfies PersonalAccessTokenListResponse;

    expect(oneTimeToken).toMatch(/^bst_/);
    expect(JSON.stringify(listed)).not.toContain("bst_example");
  });
});
