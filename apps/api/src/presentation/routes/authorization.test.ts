import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
} from "@barestash/shared/auth";
import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import type { AccountId, EventId } from "@barestash/shared/ids";
import { beforeEach, describe, expect, it } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import type {
  StoredAccount,
  StoredPersonalAccessToken,
} from "../../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../../infrastructure/in-memory/endpoint-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  RecordingEventRepository,
  RecordingRequestBodyStore,
  testTokenId,
} from "../../testing/helpers.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const OWNER: StoredAccount = {
  id: "acc_owner",
  primary_email: "owner@example.com",
  display_name: null,
  avatar_url: null,
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};
const OTHER: StoredAccount = {
  id: "acc_other",
  primary_email: "other@example.com",
  display_name: null,
  avatar_url: null,
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

type McpToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

describe("REST and MCP authorization matrix", () => {
  let app: ReturnType<typeof createTestApiApp>;
  let ownerEventsAuthorization: string;
  let ownerEndpointsReadAuthorization: string;
  let ownerEndpointsWriteAuthorization: string;
  let ownerMcpOnlyAuthorization: string;
  let ownerMcpEventsAuthorization: string;
  let otherFullAuthorization: string;
  let otherMcpEventsAuthorization: string;

  beforeEach(async () => {
    const authDomainRepository = new InMemoryAuthDomainRepository();
    const endpointRepository = new InMemoryEndpointRepository();
    const eventRepository = new RecordingEventRepository();
    const requestBodyStore = new RecordingRequestBodyStore();

    await authDomainRepository.createAccount(OWNER);
    await authDomainRepository.createAccount(OTHER);

    ownerEventsAuthorization = await createPat(
      authDomainRepository,
      "owner-events",
      OWNER.id,
      ["events:read"],
    );
    ownerEndpointsReadAuthorization = await createPat(
      authDomainRepository,
      "owner-endpoints-read",
      OWNER.id,
      ["endpoints:read"],
    );
    ownerEndpointsWriteAuthorization = await createPat(
      authDomainRepository,
      "owner-endpoints-write",
      OWNER.id,
      ["endpoints:write"],
    );
    ownerMcpOnlyAuthorization = await createPat(
      authDomainRepository,
      "owner-mcp-only",
      OWNER.id,
      ["mcp:use"],
    );
    ownerMcpEventsAuthorization = await createPat(
      authDomainRepository,
      "owner-mcp-events",
      OWNER.id,
      ["mcp:use", "events:read"],
    );
    otherFullAuthorization = await createPat(
      authDomainRepository,
      "other-full",
      OTHER.id,
      AUTHORIZATION_SCOPES.slice(),
    );
    otherMcpEventsAuthorization = await createPat(
      authDomainRepository,
      "other-mcp-events",
      OTHER.id,
      ["mcp:use", "events:read"],
    );

    await endpointRepository.createPrivateEndpoint({
      id: "ep_private_authz",
      accountId: OWNER.id,
      name: "owner private endpoint",
      now: NOW,
    });
    await endpointRepository.createTemporaryEndpoint({
      id: "ep_temporary_authz",
      name: "public temporary endpoint",
      now: NOW,
    });

    const eventIds: EventId[] = ["evt_private_authz", "evt_temporary_authz"];
    app = createTestApiApp({
      authDomainRepository,
      endpointRepository,
      eventRepository,
      requestBodyStore,
      now: () => NOW,
      generateEventId: () => eventIds.shift() ?? "evt_extra_authz",
    });

    await app.request(
      "https://ingest.example.com/ep_private_authz/private-event",
      { method: "POST", body: "private body" },
    );
    await app.request(
      "https://ingest.example.com/ep_temporary_authz/temporary-event",
      { method: "POST", body: "temporary body" },
    );
  });

  it("applies resource scopes and ownership to private REST reads while preserving temporary public reads", async () => {
    const ownedEvents = await app.request(
      "https://api.example.com/v1/endpoints/ep_private_authz/events",
      { headers: { authorization: ownerEventsAuthorization } },
    );
    expect(ownedEvents.status).toBe(200);

    const endpointList = await app.request(
      "https://api.example.com/v1/endpoints",
      { headers: { authorization: ownerEndpointsReadAuthorization } },
    );
    expect(endpointList.status).toBe(200);
    await expect(endpointList.json()).resolves.toMatchObject({
      endpoints: [expect.objectContaining({ id: "ep_private_authz" })],
    });

    const privateCreate = await app.request(
      "https://api.example.com/v1/endpoints",
      {
        method: "POST",
        headers: {
          authorization: ownerEndpointsWriteAuthorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "private" }),
      },
    );
    expect(privateCreate.status).toBe(201);

    const secretList = await app.request(
      "https://api.example.com/v1/endpoints/ep_private_authz/secrets",
      { headers: { authorization: ownerEndpointsReadAuthorization } },
    );
    expect(secretList.status).toBe(403);
    await expect(secretList.json()).resolves.toMatchObject({
      error: {
        code: "insufficient_scope",
        message: expect.stringContaining("endpoints:write"),
      },
    });

    for (const [url, init] of [
      ["https://api.example.com/v1/endpoints/ep_private_authz", {}],
      ["https://api.example.com/v1/endpoints/ep_private_authz/events", {}],
      ["https://api.example.com/v1/events/evt_private_authz", {}],
      ["https://api.example.com/v1/events/evt_private_authz/body", {}],
      [
        "https://api.example.com/v1/endpoints/ep_private_authz/events/stream",
        {},
      ],
      ["https://api.example.com/v1/endpoints/ep_private_authz/secrets", {}],
    ] as const) {
      const response = await app.request(url, {
        ...init,
        headers: { authorization: otherFullAuthorization },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "not_authorized" },
      });
    }

    for (const url of [
      "https://api.example.com/v1/endpoints/ep_temporary_authz",
      "https://api.example.com/v1/endpoints/ep_temporary_authz/events",
      "https://api.example.com/v1/events/evt_temporary_authz",
      "https://api.example.com/v1/events/evt_temporary_authz/body",
    ]) {
      const response = await app.request(url);
      expect(response.status).toBe(200);
    }

    const temporaryStream = await app.request(
      "https://api.example.com/v1/endpoints/ep_temporary_authz/events/stream",
    );
    expect(temporaryStream.status).toBe(200);
    await temporaryStream.body?.cancel();
  });

  it("requires mcp:use and the tool-specific resource scope", async () => {
    const toolsList = await mcpRequest(app, ownerMcpOnlyAuthorization, {
      method: "tools/list",
      params: {},
    });
    expect(toolsList.status).toBe(200);

    const listEndpoints = await mcpRequest(app, ownerMcpOnlyAuthorization, {
      method: "tools/call",
      params: { name: "list_endpoints", arguments: {} },
    });
    expect(listEndpoints.status).toBe(200);
    expect(mcpToolResult(await listEndpoints.json())).toMatchObject({
      isError: true,
      content: [
        {
          text: expect.stringContaining("endpoints:read"),
        },
      ],
    });

    const createTemporary = await mcpRequest(app, ownerMcpOnlyAuthorization, {
      method: "tools/call",
      params: {
        name: "create_endpoint",
        arguments: { mode: "temporary" },
      },
    });
    expect(createTemporary.status).toBe(200);
    expect(mcpToolResult(await createTemporary.json())).toMatchObject({
      isError: true,
      content: [
        {
          text: expect.stringContaining("endpoints:write"),
        },
      ],
    });

    for (const params of [
      {
        name: "list_events",
        arguments: { endpoint_id: "ep_private_authz" },
      },
      { name: "get_event", arguments: { event_id: "evt_private_authz" } },
      {
        name: "get_event_body",
        arguments: { event_id: "evt_private_authz" },
      },
    ]) {
      const eventTool = await mcpRequest(app, ownerMcpOnlyAuthorization, {
        method: "tools/call",
        params,
      });

      expect(eventTool.status).toBe(200);
      expect(mcpToolResult(await eventTool.json())).toMatchObject({
        isError: true,
        content: [
          {
            text: expect.stringContaining("events:read"),
          },
        ],
      });
    }

    const ownEvents = await mcpRequest(app, ownerMcpEventsAuthorization, {
      method: "tools/call",
      params: {
        name: "list_events",
        arguments: { endpoint_id: "ep_private_authz" },
      },
    });
    expect(ownEvents.status).toBe(200);
    const ownEventsResult = mcpToolResult(await ownEvents.json());
    expect(ownEventsResult.isError).toBeUndefined();
    expect(ownEventsResult).toMatchObject({
      content: [
        {
          text: expect.stringContaining("evt_private_authz"),
        },
      ],
    });

    const foreignEvents = await mcpRequest(app, otherMcpEventsAuthorization, {
      method: "tools/call",
      params: {
        name: "list_events",
        arguments: { endpoint_id: "ep_private_authz" },
      },
    });
    expect(foreignEvents.status).toBe(200);
    expect(mcpToolResult(await foreignEvents.json())).toMatchObject({
      isError: true,
      content: [
        {
          text: expect.stringContaining("not_authorized"),
        },
      ],
    });

    const noMcpScope = await mcpRequest(app, ownerEventsAuthorization, {
      method: "tools/list",
      params: {},
    });
    expect(noMcpScope.status).toBe(403);
    await expect(noMcpScope.json()).resolves.toMatchObject({
      error: {
        code: "insufficient_scope",
        message: expect.stringContaining("mcp:use"),
      },
    });
  });
});

async function createPat(
  repository: InMemoryAuthDomainRepository,
  label: string,
  accountId: AccountId,
  scopes: AuthorizationScope[],
): Promise<string> {
  const id = testTokenId(label);
  const secret = label
    .replaceAll(/[^A-Za-z0-9]/g, "")
    .padEnd(32, "0")
    .slice(0, 32);
  const token: StoredPersonalAccessToken = {
    id,
    account_id: accountId,
    name: label,
    token_hash: await hashCredential(secret, { pepper: "" }),
    status: "active",
    scopes,
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  };

  await repository.createPersonalAccessToken(token);

  return `Bearer ${formatBearerTokenString({
    type: "pat",
    tokenIdSuffix: id.slice("tok_".length),
    secret,
  })}`;
}

async function mcpRequest(
  app: ReturnType<typeof createTestApiApp>,
  authorization: string,
  body: { method: string; params: Record<string, unknown> },
): Promise<Response> {
  return app.request("https://api.example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
}

function mcpToolResult(body: { result: McpToolResult }): McpToolResult {
  return body.result;
}
