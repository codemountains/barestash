import type { EndpointResponse } from "@barestash/shared/endpoints";
import type { EventId, TokenId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import type { CreateApiAppOptions } from "../../container.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../../infrastructure/in-memory/endpoint-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  fixedNow,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  seedTestPersonalAccessToken,
  testTokenId,
} from "../../testing/helpers.js";

const TOK_MCP_REVOKED = testTokenId("mcp_revoked");
const TOK_MCP_LIST = testTokenId("mcp_list");
const TOK_MCP_TMP = testTokenId("mcp_tmp");
const TOK_MCP_PRIVATE = testTokenId("mcp_private");
const TOK_MCP_JSON = testTokenId("mcp_json");
const TOK_MCP_STREAM = testTokenId("mcp_stream");

const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

type McpToolCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function callMcpTool(
  app: ReturnType<typeof createTestApiApp>,
  name: string,
  args: Record<string, unknown>,
  authorization: string,
): Promise<{ response: Response; result: McpToolCallResult }> {
  const response = await app.request("https://api.example.com/mcp", {
    method: "POST",
    headers: {
      ...mcpHeaders,
      authorization,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }),
  });

  const body = (await response.json()) as { result: McpToolCallResult };

  return { response, result: body.result };
}

async function createAuthenticatedApiApp(
  tokenId: TokenId,
  seed: string,
  options: CreateApiAppOptions = {},
) {
  const authDomainRepository = new InMemoryAuthDomainRepository();
  const token = await seedTestPersonalAccessToken(
    authDomainRepository,
    tokenId,
    seed,
  );
  const app = createTestApiApp({
    ...options,
    authDomainRepository,
  });

  return { app, token };
}

function parseMcpText<T>(result: McpToolCallResult): T {
  return JSON.parse(result.content[0].text) as T;
}

describe("MCP API route", () => {
  it("requires Bearer authentication for every /mcp method before processing the request", async () => {
    const app = createTestApiApp({});
    const requests = [
      new Request("https://api.example.com/mcp", {
        method: "POST",
        headers: mcpHeaders,
        body: "not-json",
      }),
      new Request("https://api.example.com/mcp", { method: "GET" }),
      new Request("https://api.example.com/mcp", { method: "PUT" }),
    ];

    for (const request of requests) {
      const response = await app.request(request);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toEqual({
        error: {
          code: "not_authenticated",
          message: "Authentication is required.",
        },
      });
    }
  });

  it("rejects invalid and revoked Bearer tokens at the MCP transport boundary", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_REVOKED,
      "mcprevoked",
      {
        now: () => fixedNow,
      },
    );
    const authorization = `Bearer ${token}`;
    const revokeResponse = await app.request(
      `https://api.example.com/v1/tokens/${TOK_MCP_REVOKED}`,
      {
        method: "DELETE",
        headers: { authorization },
      },
    );
    expect(revokeResponse.status).toBe(200);

    for (const rejectedAuthorization of [
      "Basic malformed-credentials",
      "Bearer invalid-token",
      authorization,
    ]) {
      const response = await app.request("https://api.example.com/mcp", {
        method: "POST",
        headers: {
          ...mcpHeaders,
          authorization: rejectedAuthorization,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({
        error: {
          code:
            rejectedAuthorization === authorization
              ? "token_revoked"
              : rejectedAuthorization.startsWith("Bearer ")
                ? "invalid_token"
                : "not_authenticated",
        },
      });
    }
  });

  it("lists the initial MVP tools over POST /mcp", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_LIST,
      "mcplist",
    );

    const response = await app.request("https://api.example.com/mcp", {
      method: "POST",
      headers: {
        ...mcpHeaders,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "list_endpoints" }),
          expect.objectContaining({ name: "create_endpoint" }),
          expect.objectContaining({ name: "list_events" }),
          expect.objectContaining({ name: "get_event" }),
          expect.objectContaining({ name: "get_event_body" }),
        ]),
      },
      jsonrpc: "2.0",
      id: 1,
    });
  });

  it("creates and reads temporary endpoints and raw event bodies through MCP", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_TMP,
      "mcptmp",
      {
        endpointRepository: new InMemoryEndpointRepository(),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
        generateEndpointId: () => "ep_mcp_tmp",
        generateEventId: () => "evt_mcp_tmp",
      },
    );
    const authorization = `Bearer ${token}`;
    const bodyBytes = new Uint8Array([0, 1, 2, 255]);

    const create = await callMcpTool(
      app,
      "create_endpoint",
      {
        mode: "temporary",
        name: "mcp-temp",
      },
      authorization,
    );
    expect(create.response.status).toBe(200);
    expect(parseMcpText<EndpointResponse>(create.result)).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_mcp_tmp",
        mode: "temporary",
        public_read: true,
      }),
    });

    const endpoints = await callMcpTool(
      app,
      "list_endpoints",
      {},
      authorization,
    );
    expect(endpoints.response.status).toBe(200);
    expect(parseMcpText(endpoints.result)).toEqual({ endpoints: [] });

    const ingestResponse = await app.request(
      "https://ingest.example.com/ep_mcp_tmp/binary?debug=true",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: "Bearer provider-token",
        },
        body: bodyBytes,
      },
    );
    expect(ingestResponse.status).toBe(204);

    const publicEventsResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_mcp_tmp/events",
    );
    expect(publicEventsResponse.status).toBe(200);

    const events = await callMcpTool(
      app,
      "list_events",
      {
        endpoint_id: "ep_mcp_tmp",
      },
      authorization,
    );
    expect(events.response.status).toBe(200);
    expect(parseMcpText(events.result)).toEqual({
      events: [
        expect.objectContaining({
          id: "evt_mcp_tmp",
          endpoint_id: "ep_mcp_tmp",
          request_path: "/binary",
        }),
      ],
    });

    const event = await callMcpTool(
      app,
      "get_event",
      {
        event_id: "evt_mcp_tmp",
      },
      authorization,
    );
    expect(event.response.status).toBe(200);
    expect(parseMcpText(event.result)).toEqual({
      id: "evt_mcp_tmp",
      endpoint_id: "ep_mcp_tmp",
      request: expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "[REDACTED]",
        }),
      }),
      received_at: "2026-07-05T12:00:00.000Z",
    });

    const body = await callMcpTool(
      app,
      "get_event_body",
      {
        event_id: "evt_mcp_tmp",
      },
      authorization,
    );
    expect(body.response.status).toBe(200);
    expect(parseMcpText(body.result)).toEqual({
      encoding: "base64",
      data: "AAEC/w==",
      content_type: "application/octet-stream",
      size: 4,
      sha256:
        "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    });
  });

  it("requires Bearer authentication for private endpoint MCP access without leaking secrets", async () => {
    let endpointSequence = 0;
    let eventSequence = 0;
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_PRIVATE,
      "mcpprivate",
      {
        endpointRepository: new InMemoryEndpointRepository(),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
        generateEndpointId: () => {
          endpointSequence += 1;
          return endpointSequence === 1 ? "ep_private" : "ep_unused";
        },
        generateEventId: () => {
          eventSequence += 1;
          return `evt_private_${eventSequence}` as EventId;
        },
        generateSecretId: () => "sec_mcp_private",
        generateEndpointSecret: () => "endpoint-secret-raw",
      },
    );

    const authorization = `Bearer ${token}`;

    const createPrivate = await callMcpTool(
      app,
      "create_endpoint",
      { mode: "private" },
      authorization,
    );
    expect(createPrivate.response.status).toBe(200);
    expect(parseMcpText<EndpointResponse>(createPrivate.result)).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_private",
        mode: "private",
        public_read: false,
      }),
    });

    const secretResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      {
        method: "POST",
        headers: { authorization },
      },
    );
    expect(secretResponse.status).toBe(201);

    const ingestResponse = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-barestash-secret": "endpoint-secret-raw",
        },
        body: JSON.stringify({ provider: "kept raw" }),
      },
    );
    expect(ingestResponse.status).toBe(204);

    const authEvent = await callMcpTool(
      app,
      "get_event",
      { event_id: "evt_private_1" },
      authorization,
    );
    expect(authEvent.response.status).toBe(200);
    const eventJson = authEvent.result.content[0].text;
    expect(JSON.parse(eventJson)).toEqual({
      id: "evt_private_1",
      endpoint_id: "ep_private",
      request: expect.objectContaining({
        headers: {
          "content-type": "application/json",
        },
      }),
      received_at: "2026-07-05T12:00:00.000Z",
    });
    expect(eventJson).not.toContain(token);
    expect(eventJson).not.toContain("endpoint-secret-raw");
    expect(eventJson).not.toContain("x-barestash-secret");
  });

  it("does not parse or pretty print JSON bodies in get_event_body", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_JSON,
      "mcpjson",
      {
        endpointRepository: new InMemoryEndpointRepository(),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
        generateEndpointId: () => "ep_json",
        generateEventId: () => "evt_json",
      },
    );
    const authorization = `Bearer ${token}`;
    const rawJson = '{"z":2,"a":1}';

    await callMcpTool(
      app,
      "create_endpoint",
      {
        mode: "temporary",
      },
      authorization,
    );
    await app.request("https://ingest.example.com/ep_json/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawJson,
    });

    const body = await callMcpTool(
      app,
      "get_event_body",
      {
        event_id: "evt_json",
      },
      authorization,
    );

    expect(body.response.status).toBe(200);
    expect(parseMcpText(body.result)).toEqual({
      encoding: "base64",
      data: "eyJ6IjoyLCJhIjoxfQ==",
      content_type: "application/json",
      size: rawJson.length,
      sha256:
        "83744feac5ed0990322af80b4ad963704487ecd0625369b31cfdfda4f9c1366a",
    });
  });

  it("keeps long-running MCP streaming out of the MVP", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      TOK_MCP_STREAM,
      "mcpstream",
    );
    const response = await app.request("https://api.example.com/mcp", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe(
      "MCP streaming is not supported in MVP. Use POST /mcp.",
    );
  });
});
