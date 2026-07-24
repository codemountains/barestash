import type { AuthorizationScope, AuthPrincipal } from "@barestash/shared/auth";
import {
  createRestErrorResponse,
  type RestErrorCode,
} from "@barestash/shared/errors";
import {
  assertEndpointId,
  assertEventId,
  type EndpointId,
  type EventId,
  isEndpointId,
  isEventId,
} from "@barestash/shared/ids";
import {
  type CallToolResult,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import * as z from "zod/v4";

import {
  authenticateResourcePrincipal,
  recordPrincipalLastUsed,
  requireScope,
} from "../../application/auth.js";
import { createEndpoint, listEndpoints } from "../../application/endpoints.js";
import {
  getEventBody,
  getEventDetail,
  listEvents,
} from "../../application/events.js";
import { clientIpRateLimitKey } from "../../application/rate-limit.js";
import type { UseCaseError, UseCaseResult } from "../../application/result.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
  getEndpointRepository,
  getEventRepository,
  getRequestBodyStore,
} from "../../container.js";
import { checkContextRateLimit, enforceHttpRateLimit } from "../rate-limit.js";
import { getAuthorizationHeader } from "../request.js";
import { respondRateLimitError } from "../response.js";

const MCP_STREAMING_OUT_OF_SCOPE_MESSAGE =
  "MCP streaming is not supported in MVP. Use POST /mcp.";

type ApiContext = Context<ApiEnv>;

type ToolJsonResult = CallToolResult;

type McpRequestState = {
  rateLimitUnavailable: UseCaseError | null;
};

function jsonToolResult(value: unknown): ToolJsonResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}

function toolError(error: UseCaseError): ToolJsonResult {
  return {
    ...jsonToolResult({
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
      },
    }),
    isError: true,
  };
}

function inputError(
  code: RestErrorCode,
  message: string,
  status: UseCaseError["status"],
): ToolJsonResult {
  return toolError({
    kind: "error",
    code,
    message,
    status,
  });
}

function resultToToolResult<T>(result: UseCaseResult<T>): ToolJsonResult {
  return result.kind === "error"
    ? toolError(result)
    : jsonToolResult(result.value);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function mcpEndpointId(value: string): EndpointId | ToolJsonResult {
  if (!isEndpointId(value)) {
    return inputError(
      "endpoint_not_found",
      `Endpoint not found: ${value}`,
      404,
    );
  }

  return assertEndpointId(value);
}

function mcpEventId(value: string): EventId | ToolJsonResult {
  if (!isEventId(value)) {
    return inputError("event_not_found", `Event not found: ${value}`, 404);
  }

  return assertEventId(value);
}

function isToolJsonResult(
  value: EndpointId | EventId | ToolJsonResult,
): value is ToolJsonResult {
  return typeof value === "object" && "content" in value;
}

function requireMcpToolScope(
  principal: AuthPrincipal,
  resourceScope: AuthorizationScope,
): UseCaseResult<AuthPrincipal> {
  const mcpAccess = requireScope(principal, "mcp:use");

  return mcpAccess.kind === "error"
    ? mcpAccess
    : requireScope(mcpAccess.value, resourceScope);
}

function createMcpServer(
  context: ApiContext,
  deps: AppDeps,
  request: Request,
  principal: AuthPrincipal,
  requestState: McpRequestState,
): McpServer {
  const server = new McpServer({
    name: "barestash",
    version: "0.0.0",
  });
  const authorizationHeader = getAuthorizationHeader(request);
  const credentialPepper = getCredentialPepper(context);
  const authenticatedTokenId = principal.credential.id;

  server.registerTool(
    "list_endpoints",
    {
      title: "List Endpoints",
      description:
        "List private Barestash endpoints for the authenticated account.",
      inputSchema: z.object({}),
    },
    async () => {
      const authorized = requireMcpToolScope(principal, "endpoints:read");

      if (authorized.kind === "error") return toolError(authorized);

      return resultToToolResult(
        await listEndpoints({
          endpointRepository: getEndpointRepository(context, deps),
          tokenRepository: getAuthDomainRepository(context, deps),
          now: deps.getNow(),
          authorizationHeader,
          requestUrl: request.url,
          ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
          credentialPepper,
        }),
      );
    },
  );

  server.registerTool(
    "create_endpoint",
    {
      title: "Create Endpoint",
      description: "Create a temporary or private Barestash endpoint.",
      inputSchema: z.object({
        mode: z.enum(["private", "temporary"]).optional(),
        name: z.string().optional(),
      }),
    },
    async (body) => {
      const authorized = requireMcpToolScope(principal, "endpoints:write");

      if (authorized.kind === "error") return toolError(authorized);

      const rateLimit = await checkContextRateLimit(context, deps, {
        binding: "ENDPOINT_CREATION_RATE_LIMITER",
        key: `token:${authenticatedTokenId}`,
        surface: "endpoint_creation",
      });

      if (rateLimit.kind === "error") {
        if (rateLimit.code === "rate_limit_unavailable") {
          requestState.rateLimitUnavailable = rateLimit;
        }

        return toolError(rateLimit);
      }

      return resultToToolResult(
        await createEndpoint({
          endpointRepository: getEndpointRepository(context, deps),
          tokenRepository: getAuthDomainRepository(context, deps),
          now: deps.getNow(),
          makeEndpointId: deps.makeEndpointId,
          authorizationHeader,
          requestUrl: request.url,
          ingestHostname: context.env?.BARESTASH_INGEST_HOSTNAME,
          body,
          credentialPepper,
        }),
      );
    },
  );

  server.registerTool(
    "list_events",
    {
      title: "List Events",
      description: "List events captured for a Barestash endpoint.",
      inputSchema: z.object({
        endpoint_id: z.string(),
        after: z.string().optional(),
        before: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
    },
    async ({ endpoint_id, after, before, limit }) => {
      const authorized = requireMcpToolScope(principal, "events:read");

      if (authorized.kind === "error") return toolError(authorized);

      const endpointId = mcpEndpointId(endpoint_id);

      if (isToolJsonResult(endpointId)) {
        return endpointId;
      }

      return resultToToolResult(
        await listEvents({
          endpointRepository: getEndpointRepository(context, deps),
          tokenRepository: getAuthDomainRepository(context, deps),
          eventRepository: getEventRepository(context, deps),
          now: deps.getNow(),
          authorizationHeader,
          endpointId,
          afterParam: after ?? null,
          beforeParam: before ?? null,
          limitParam: limit === undefined ? null : String(limit),
          credentialPepper,
        }),
      );
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Get Event",
      description: "Read captured event metadata and request details.",
      inputSchema: z.object({
        event_id: z.string(),
      }),
    },
    async ({ event_id }) => {
      const authorized = requireMcpToolScope(principal, "events:read");

      if (authorized.kind === "error") return toolError(authorized);

      const eventId = mcpEventId(event_id);

      if (isToolJsonResult(eventId)) {
        return eventId;
      }

      return resultToToolResult(
        await getEventDetail({
          endpointRepository: getEndpointRepository(context, deps),
          tokenRepository: getAuthDomainRepository(context, deps),
          eventRepository: getEventRepository(context, deps),
          requestBodyStore: getRequestBodyStore(context, deps),
          now: deps.getNow(),
          authorizationHeader,
          eventId,
          credentialPepper,
        }),
      );
    },
  );

  server.registerTool(
    "get_event_body",
    {
      title: "Get Event Body",
      description:
        "Read a captured event body as base64 without parsing or pretty-printing.",
      inputSchema: z.object({
        event_id: z.string(),
      }),
    },
    async ({ event_id }) => {
      const authorized = requireMcpToolScope(principal, "events:read");

      if (authorized.kind === "error") return toolError(authorized);

      const eventId = mcpEventId(event_id);

      if (isToolJsonResult(eventId)) {
        return eventId;
      }

      const result = await getEventBody({
        endpointRepository: getEndpointRepository(context, deps),
        tokenRepository: getAuthDomainRepository(context, deps),
        eventRepository: getEventRepository(context, deps),
        requestBodyStore: getRequestBodyStore(context, deps),
        now: deps.getNow(),
        authorizationHeader,
        eventId,
        credentialPepper,
      });

      if (result.kind === "error") {
        return toolError(result);
      }

      return jsonToolResult({
        encoding: "base64",
        data: base64Encode(result.value.bodyBytes),
        content_type: result.value.contentType,
        size: result.value.size,
        sha256: result.value.sha256,
      });
    },
  );

  return server;
}

/** @public */
export function registerMcpRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.use("/mcp", async (context, next) => {
    const ipRateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "ABUSE_IP_RATE_LIMITER",
      key: clientIpRateLimitKey(context.req.raw),
      surface: "mcp_ip",
    });

    if (ipRateLimited !== null) {
      return ipRateLimited;
    }

    const tokenRepository = getAuthDomainRepository(context, deps);
    const authentication = await authenticateResourcePrincipal(
      getAuthorizationHeader(context.req.raw),
      tokenRepository,
      deps.getNow(),
      { pepper: getCredentialPepper(context) },
      false,
    );

    if (authentication.kind === "error") {
      return context.json(
        createRestErrorResponse(authentication.code, authentication.message),
        authentication.status,
        { "www-authenticate": "Bearer" },
      );
    }

    const mcpAccess = requireScope(authentication.value, "mcp:use");

    if (mcpAccess.kind === "error") {
      return context.json(
        createRestErrorResponse(mcpAccess.code, mcpAccess.message),
        mcpAccess.status,
        { "www-authenticate": "Bearer" },
      );
    }

    const tokenRateLimited = await enforceHttpRateLimit(context, deps, {
      binding: "MCP_RATE_LIMITER",
      key: `token:${mcpAccess.value.credential.id}`,
      surface: "mcp",
    });

    if (tokenRateLimited !== null) {
      return tokenRateLimited;
    }

    await recordPrincipalLastUsed(
      mcpAccess.value,
      tokenRepository,
      deps.getNow(),
    );

    context.set("authenticatedMcpTokenId", mcpAccess.value.credential.id);
    context.set("authenticatedMcpPrincipal", mcpAccess.value);

    await next();
  });

  app.post("/mcp", async (context) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const authenticatedTokenId = context.get("authenticatedMcpTokenId");
    const principal = context.get("authenticatedMcpPrincipal");

    if (authenticatedTokenId === undefined || principal === undefined) {
      return context.json(
        createRestErrorResponse(
          "rate_limit_unavailable",
          "Request cannot be processed because abuse protection is unavailable.",
        ),
        503,
        { "retry-after": "60" },
      );
    }

    const requestState: McpRequestState = {
      rateLimitUnavailable: null,
    };
    const server = createMcpServer(
      context,
      deps,
      context.req.raw,
      principal,
      requestState,
    );

    await server.connect(transport);

    const response = await transport.handleRequest(context.req.raw);

    return requestState.rateLimitUnavailable === null
      ? response
      : respondRateLimitError(context, requestState.rateLimitUnavailable);
  });

  app.get("/mcp", (context) =>
    context.text(MCP_STREAMING_OUT_OF_SCOPE_MESSAGE, 405, {
      allow: "POST",
    }),
  );

  app.all("/mcp", (context) =>
    context.json(
      createRestErrorResponse("invalid_request", "Method not allowed."),
      405,
      { allow: "POST" },
    ),
  );
}
