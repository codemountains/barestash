import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import {
  formatBearerTokenString,
  parseBearerTokenString,
} from "@barestash/shared/bearer-tokens";
import { describe, expect, it } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import type { RateLimitBinding } from "../../application/rate-limit.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../../infrastructure/in-memory/endpoint-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  fixedNow,
  makeTemporaryEndpointRepository,
  makeTestTokenSecret,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  testTokenId,
} from "../../testing/helpers.js";

const TOK_MCP_LIMITED = testTokenId("mcp_limited");
const TOK_MCP_CREATE_LIMITED = testTokenId("mcp_create_limited");
const TOK_MCP_CREATE_UNAVAILABLE = testTokenId("mcp_create_unavailable");
const TOK_WRITE_LIMITED = testTokenId("write_limited");
const TOK_TARGET = testTokenId("target");
const MCP_ACCESS_TOKEN_ID = "atk_ZYXWVUTSRQPONMLKJIHGFEDC" as const;
const MCP_CLI_SESSION_ID = "cls_mcp_rate_limit" as const;
const MCP_ACCOUNT_ID = "acc_mcp_rate_limit" as const;
const MCP_ACCESS_TOKEN_SECRET = "m".repeat(32);

class StubRateLimiter implements RateLimitBinding {
  readonly keys: string[] = [];

  constructor(private readonly result: { success: boolean } | Error) {}

  async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);

    if (this.result instanceof Error) {
      throw this.result;
    }

    return this.result;
  }
}

class PerKeyLimitOneRateLimiter implements RateLimitBinding {
  readonly keys: string[] = [];
  readonly counts = new Map<string, number>();

  async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);
    const count = (this.counts.get(input.key) ?? 0) + 1;
    this.counts.set(input.key, count);
    return { success: count <= 1 };
  }
}

class RecordingLastUsedAuthDomainRepository extends InMemoryAuthDomainRepository {
  accountFindCount = 0;
  patFindCount = 0;
  accessTokenFindCount = 0;
  cliSessionFindCount = 0;
  patUpdateCount = 0;
  accessTokenUpdateCount = 0;
  cliSessionUpdateCount = 0;

  override async findAccountById(
    id: Parameters<InMemoryAuthDomainRepository["findAccountById"]>[0],
  ) {
    this.accountFindCount += 1;
    return super.findAccountById(id);
  }

  override async findPersonalAccessTokenById(
    id: Parameters<
      InMemoryAuthDomainRepository["findPersonalAccessTokenById"]
    >[0],
  ) {
    this.patFindCount += 1;
    return super.findPersonalAccessTokenById(id);
  }

  override async findAccessTokenById(
    id: Parameters<InMemoryAuthDomainRepository["findAccessTokenById"]>[0],
  ) {
    this.accessTokenFindCount += 1;
    return super.findAccessTokenById(id);
  }

  override async findCliSessionById(
    id: Parameters<InMemoryAuthDomainRepository["findCliSessionById"]>[0],
  ) {
    this.cliSessionFindCount += 1;
    return super.findCliSessionById(id);
  }

  override async updatePersonalAccessTokenLastUsed(
    id: Parameters<
      InMemoryAuthDomainRepository["updatePersonalAccessTokenLastUsed"]
    >[0],
    lastUsedAt: string,
  ): Promise<void> {
    this.patUpdateCount += 1;
    await super.updatePersonalAccessTokenLastUsed(id, lastUsedAt);
  }

  override async updateAccessTokenLastUsed(
    id: Parameters<
      InMemoryAuthDomainRepository["updateAccessTokenLastUsed"]
    >[0],
    lastUsedAt: string,
  ): Promise<void> {
    this.accessTokenUpdateCount += 1;
    await super.updateAccessTokenLastUsed(id, lastUsedAt);
  }

  override async updateCliSessionLastUsed(
    id: Parameters<InMemoryAuthDomainRepository["updateCliSessionLastUsed"]>[0],
    lastUsedAt: string,
  ): Promise<void> {
    this.cliSessionUpdateCount += 1;
    await super.updateCliSessionLastUsed(id, lastUsedAt);
  }

  resetAuthenticationCounts(): void {
    this.accountFindCount = 0;
    this.patFindCount = 0;
    this.accessTokenFindCount = 0;
    this.cliSessionFindCount = 0;
  }

  resetLastUsedCounts(): void {
    this.patUpdateCount = 0;
    this.accessTokenUpdateCount = 0;
    this.cliSessionUpdateCount = 0;
  }
}

const allow = () => new StubRateLimiter({ success: true });
const deny = () => new StubRateLimiter({ success: false });

async function expectHttpRateLimit(response: Response, status = 429) {
  expect(response.status).toBe(status);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.json()).toEqual({
    error: {
      code: status === 429 ? "rate_limit_exceeded" : "rate_limit_unavailable",
      message:
        status === 429
          ? "Too many requests."
          : "Request cannot be processed because abuse protection is unavailable.",
    },
  });
}

async function createToken(
  repository: InMemoryAuthDomainRepository,
  tokenId: ReturnType<typeof testTokenId>,
  seed: string,
) {
  const token = makeTestTokenSecret(tokenId, seed);
  const parsed = parseBearerTokenString(token);
  if (parsed?.type !== "pat") throw new Error("Invalid test PAT.");
  await repository.createAccountIfAbsent({
    id: "acc_rate_limit",
    primary_email: "rate-limit@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
  });
  await repository.createPersonalAccessToken({
    id: tokenId,
    account_id: "acc_rate_limit",
    name: "rate-limit-test",
    token_hash: await hashCredential(parsed.secret),
    status: "active",
    scopes: AUTHORIZATION_SCOPES.slice(),
    created_at: fixedNow.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  });
  return token;
}

async function createCliAccessCredential(
  repository: InMemoryAuthDomainRepository,
): Promise<string> {
  await repository.createAccount({
    id: MCP_ACCOUNT_ID,
    primary_email: "mcp@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
  });
  await repository.createCliSession({
    id: MCP_CLI_SESSION_ID,
    account_id: MCP_ACCOUNT_ID,
    device_name: null,
    client_version: "0.1.0",
    status: "active",
    scopes: AUTHORIZATION_SCOPES.slice(),
    created_at: fixedNow.toISOString(),
    last_used_at: null,
    idle_expires_at: "2026-08-05T12:00:00.000Z",
    absolute_expires_at: "2026-10-05T12:00:00.000Z",
    revoked_at: null,
    compromised_at: null,
  });
  await repository.createAccessToken({
    id: MCP_ACCESS_TOKEN_ID,
    session_id: MCP_CLI_SESSION_ID,
    token_hash: await hashCredential(MCP_ACCESS_TOKEN_SECRET),
    status: "active",
    created_at: fixedNow.toISOString(),
    expires_at: "2026-07-05T13:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  });

  return formatBearerTokenString({
    type: "access",
    tokenIdSuffix: MCP_ACCESS_TOKEN_ID.slice("atk_".length),
    secret: MCP_ACCESS_TOKEN_SECRET,
  });
}

function mcpToolsListRequest(token: string): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.14",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  };
}

describe("API rate limit boundaries", () => {
  it("rate-limits endpoint creation before creating metadata", async () => {
    const repository = new InMemoryEndpointRepository();
    const limiter = deny();
    const app = createTestApiApp({
      endpointRepository: repository,
      rateLimiters: { ENDPOINT_CREATION_RATE_LIMITER: limiter },
    });

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.11",
      },
      body: JSON.stringify({ mode: "temporary" }),
    });

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual(["ip:203.0.113.11"]);
    expect(await repository.listActiveTemporaryEndpoints(fixedNow)).toEqual([]);
  });

  it.each([
    ["ABUSE_IP_RATE_LIMITER", "ip:203.0.113.12"],
    ["INGEST_ENDPOINT_RATE_LIMITER", "endpoint:ep_01JDEF"],
  ] as const)("blocks ingest at %s before storing an event", async (bindingName, expectedKey) => {
    const limiter = deny();
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER:
          bindingName === "ABUSE_IP_RATE_LIMITER" ? limiter : allow(),
        INGEST_ENDPOINT_RATE_LIMITER:
          bindingName === "INGEST_ENDPOINT_RATE_LIMITER" ? limiter : allow(),
      },
    });

    const response = await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook",
      {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.12" },
        body: "must not be stored",
      },
    );

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual([expectedKey]);
    expect(eventRepository.events).toEqual([]);
    expect(bodyStore.objects.size).toBe(0);
  });

  it("uses a dedicated PAT write limiter for token issuance", async () => {
    const limiter = deny();
    const app = createTestApiApp({
      rateLimiters: { PAT_WRITE_RATE_LIMITER: limiter },
    });

    const response = await app.request("https://api.example.com/v1/tokens", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.13",
        "x-barestash-bootstrap-token":
          "bootstrap-secret-for-local-staging-tests-ok",
      },
    });

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual(["ip:203.0.113.13"]);
  });

  it("rate limits malformed PAT revocation attempts before token ID validation", async () => {
    const abuseLimiter = allow();
    const patWriteLimiter = deny();
    const app = createTestApiApp({
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: abuseLimiter,
        PAT_WRITE_RATE_LIMITER: patWriteLimiter,
      },
    });

    const response = await app.request(
      "https://api.example.com/v1/tokens/not-a-token-id",
      {
        method: "DELETE",
        headers: { "cf-connecting-ip": "203.0.113.14" },
      },
    );

    await expectHttpRateLimit(response);
    expect(abuseLimiter.keys).toEqual(["ip:203.0.113.14"]);
    expect(patWriteLimiter.keys).toEqual(["ip:203.0.113.14"]);
  });

  it("uses a dedicated refresh limiter for refresh-token exchange", async () => {
    const limiter = deny();
    const app = createTestApiApp({
      rateLimiters: { REFRESH_RATE_LIMITER: limiter },
    });

    const response = await app.request(
      "https://api.example.com/v1/auth/token/refresh",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.21",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "synthetic-refresh-token",
        }),
      },
    );

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual(["ip:203.0.113.21"]);
  });

  it("updates MCP token last-used only after its token limiter passes", async () => {
    const limiter = new PerKeyLimitOneRateLimiter();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_MCP_LIMITED,
      "mcplimited",
    );
    const app = createTestApiApp({
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        MCP_RATE_LIMITER: limiter,
      },
    });
    const request = mcpToolsListRequest(token);

    const accepted = await app.request("https://api.example.com/mcp", request);

    expect(accepted.status).toBe(200);
    expect(authDomainRepository.patUpdateCount).toBe(1);

    const rateLimited = await app.request(
      "https://api.example.com/mcp",
      request,
    );

    await expectHttpRateLimit(rateLimited);
    expect(limiter.keys).toEqual([
      `token:${TOK_MCP_LIMITED}`,
      `token:${TOK_MCP_LIMITED}`,
    ]);
    expect(authDomainRepository.patUpdateCount).toBe(1);
  });

  it("updates MCP access-token and CLI-session last-used only after the limiter passes", async () => {
    const limiter = new PerKeyLimitOneRateLimiter();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const accessToken = await createCliAccessCredential(authDomainRepository);
    const app = createTestApiApp({
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        MCP_RATE_LIMITER: limiter,
      },
    });
    const request = mcpToolsListRequest(accessToken);

    const accepted = await app.request("https://api.example.com/mcp", request);

    expect(accepted.status).toBe(200);
    expect(authDomainRepository.accessTokenUpdateCount).toBe(1);
    expect(authDomainRepository.cliSessionUpdateCount).toBe(1);

    const rateLimited = await app.request(
      "https://api.example.com/mcp",
      request,
    );

    await expectHttpRateLimit(rateLimited);
    expect(limiter.keys).toEqual([
      `token:${MCP_ACCESS_TOKEN_ID}`,
      `token:${MCP_ACCESS_TOKEN_ID}`,
    ]);
    expect(authDomainRepository.accessTokenUpdateCount).toBe(1);
    expect(authDomainRepository.cliSessionUpdateCount).toBe(1);
  });

  it("applies the shared IP abuse limit before MCP authentication", async () => {
    const limiter = deny();
    const app = createTestApiApp({
      rateLimiters: { ABUSE_IP_RATE_LIMITER: limiter },
    });

    const response = await app.request("https://api.example.com/mcp", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.19" },
      body: "not-json",
    });

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual(["ip:203.0.113.19"]);
  });

  it("returns an MCP tool error when create_endpoint exceeds its quota", async () => {
    const limiter = deny();
    const authDomainRepository = new InMemoryAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_MCP_CREATE_LIMITED,
      "mcpcreatelimited",
    );
    const app = createTestApiApp({
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        MCP_RATE_LIMITER: allow(),
        ENDPOINT_CREATION_RATE_LIMITER: limiter,
      },
    });
    const response = await app.request("https://api.example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.15",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_endpoint",
          arguments: { mode: "temporary" },
        },
      }),
    });
    const body = (await response.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests.",
        status: 429,
      },
    });
    expect(limiter.keys).toEqual([`token:${TOK_MCP_CREATE_LIMITED}`]);
  });

  it("returns HTTP 503 when the MCP create_endpoint limiter is unavailable", async () => {
    const limiter = new StubRateLimiter(new Error("unavailable"));
    const repository = new InMemoryEndpointRepository();
    const authDomainRepository = new InMemoryAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_MCP_CREATE_UNAVAILABLE,
      "mcpcreateunavailable",
    );
    const app = createTestApiApp({
      endpointRepository: repository,
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        MCP_RATE_LIMITER: allow(),
        ENDPOINT_CREATION_RATE_LIMITER: limiter,
      },
    });
    const response = await app.request("https://api.example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.21",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_endpoint",
          arguments: { mode: "temporary" },
        },
      }),
    });

    await expectHttpRateLimit(response, 503);
    expect(limiter.keys).toEqual([`token:${TOK_MCP_CREATE_UNAVAILABLE}`]);
    expect(await repository.listActiveTemporaryEndpoints(fixedNow)).toEqual([]);
  });

  it("rate-limits authenticated write APIs before mutation", async () => {
    const repository = new InMemoryEndpointRepository();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const limiter = deny();
    const token = await createToken(
      authDomainRepository,
      TOK_WRITE_LIMITED,
      "writelimited",
    );
    const app = createTestApiApp({
      endpointRepository: repository,
      authDomainRepository,
      now: () => fixedNow,
      generateEndpointId: () => "ep_write_limited",
      rateLimiters: { WRITE_RATE_LIMITER: limiter },
    });
    const authorization = `Bearer ${token}`;
    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.16",
        authorization,
      },
      body: JSON.stringify({ mode: "private" }),
    });
    authDomainRepository.resetAuthenticationCounts();
    authDomainRepository.resetLastUsedCounts();

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_write_limited",
      {
        method: "DELETE",
        headers: { authorization },
      },
    );

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual([`token:${TOK_WRITE_LIMITED}`]);
    expect(authDomainRepository.patFindCount).toBe(1);
    expect(authDomainRepository.patUpdateCount).toBe(0);
    expect(await repository.findEndpoint("ep_write_limited")).not.toBeNull();
  });

  it("does not update last-used when the authenticated write limiter is unavailable", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_WRITE_LIMITED,
      "writeunavailable",
    );
    const app = createTestApiApp({
      endpointRepository,
      authDomainRepository,
      now: () => fixedNow,
      generateEndpointId: () => "ep_write_unavailable",
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        WRITE_RATE_LIMITER: new StubRateLimiter(new Error("unavailable")),
      },
    });
    const authorization = `Bearer ${token}`;
    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "private" }),
    });
    authDomainRepository.resetAuthenticationCounts();
    authDomainRepository.resetLastUsedCounts();

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_write_unavailable",
      {
        method: "DELETE",
        headers: {
          authorization,
          "cf-connecting-ip": "203.0.113.24",
        },
      },
    );

    await expectHttpRateLimit(response, 503);
    expect(authDomainRepository.patFindCount).toBe(1);
    expect(authDomainRepository.patUpdateCount).toBe(0);
    expect(
      await endpointRepository.findEndpoint("ep_write_unavailable"),
    ).not.toBeNull();
  });

  it("authenticates a PAT only once for an accepted endpoint write", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_WRITE_LIMITED,
      "writeaccepted",
    );
    const app = createTestApiApp({
      endpointRepository,
      authDomainRepository,
      now: () => fixedNow,
      generateEndpointId: () => "ep_write_accepted",
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        WRITE_RATE_LIMITER: allow(),
      },
    });
    const authorization = `Bearer ${token}`;
    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "private" }),
    });
    authDomainRepository.resetAuthenticationCounts();
    authDomainRepository.resetLastUsedCounts();

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_write_accepted",
      {
        method: "DELETE",
        headers: {
          authorization,
          "cf-connecting-ip": "203.0.113.22",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(authDomainRepository.patFindCount).toBe(1);
    expect(authDomainRepository.accountFindCount).toBe(1);
    expect(authDomainRepository.patUpdateCount).toBe(1);
  });

  it("authenticates a CLI access token only once for an accepted PAT write", async () => {
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const token = await createCliAccessCredential(authDomainRepository);
    const app = createTestApiApp({
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        PAT_WRITE_RATE_LIMITER: allow(),
      },
    });

    const response = await app.request("https://api.example.com/v1/tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "single-authentication",
        "cf-connecting-ip": "203.0.113.23",
      },
      body: JSON.stringify({ scopes: ["events:read"] }),
    });

    expect(response.status).toBe(201);
    expect(authDomainRepository.accessTokenFindCount).toBe(1);
    expect(authDomainRepository.cliSessionFindCount).toBe(1);
    expect(authDomainRepository.accountFindCount).toBe(1);
    expect(authDomainRepository.accessTokenUpdateCount).toBe(1);
    expect(authDomainRepository.cliSessionUpdateCount).toBe(1);
  });

  it("reuses revoked PAT verification for an idempotent self-revocation retry", async () => {
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const token = await createToken(
      authDomainRepository,
      TOK_WRITE_LIMITED,
      "selfrevocation",
    );
    const limiter = allow();
    const app = createTestApiApp({
      authDomainRepository,
      now: () => fixedNow,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        PAT_WRITE_RATE_LIMITER: limiter,
      },
    });
    const request = {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.25",
      },
    };

    const first = await app.request(
      `https://api.example.com/v1/tokens/${TOK_WRITE_LIMITED}`,
      request,
    );
    expect(first.status).toBe(200);
    authDomainRepository.resetAuthenticationCounts();
    authDomainRepository.resetLastUsedCounts();

    const retry = await app.request(
      `https://api.example.com/v1/tokens/${TOK_WRITE_LIMITED}`,
      request,
    );

    expect(retry.status).toBe(200);
    expect(authDomainRepository.patFindCount).toBe(1);
    expect(authDomainRepository.accountFindCount).toBe(0);
    expect(authDomainRepository.patUpdateCount).toBe(0);
    expect(limiter.keys).toEqual([
      `token:${TOK_WRITE_LIMITED}`,
      "ip:203.0.113.25",
    ]);
  });

  it("maps rotating invalid Bearer credentials to the same write IP bucket", async () => {
    const limiter = new PerKeyLimitOneRateLimiter();
    const authDomainRepository = new RecordingLastUsedAuthDomainRepository();
    const firstInvalid = makeTestTokenSecret(
      testTokenId("invalid_one"),
      "invalidone",
    );
    const secondInvalid = makeTestTokenSecret(
      testTokenId("invalid_two"),
      "invalidtwo",
    );
    const app = createTestApiApp({
      authDomainRepository,
      rateLimiters: {
        ABUSE_IP_RATE_LIMITER: allow(),
        PAT_WRITE_RATE_LIMITER: limiter,
      },
    });

    const first = await app.request(
      `https://api.example.com/v1/tokens/${TOK_TARGET}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${firstInvalid}`,
          "cf-connecting-ip": "203.0.113.20",
        },
      },
    );
    const second = await app.request(
      `https://api.example.com/v1/tokens/${TOK_TARGET}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${secondInvalid}`,
          "cf-connecting-ip": "203.0.113.20",
        },
      },
    );

    expect(first.status).toBe(401);
    await expectHttpRateLimit(second);
    expect(limiter.keys).toEqual(["ip:203.0.113.20", "ip:203.0.113.20"]);
    expect(authDomainRepository.patFindCount).toBe(2);
    expect(authDomainRepository.accountFindCount).toBe(0);
  });

  it("rate-limits SSE connection starts by endpoint and actor", async () => {
    const limiter = deny();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      rateLimiters: { SSE_RATE_LIMITER: limiter },
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
      {
        headers: {
          authorization: "Bearer rotating-invalid-token",
          "cf-connecting-ip": "203.0.113.17",
        },
      },
    );

    await expectHttpRateLimit(response);
    expect(limiter.keys).toEqual(["endpoint:ep_01JDEF:actor:ip:203.0.113.17"]);
  });

  it("fails closed with 503 when a limiter is unavailable", async () => {
    const app = createTestApiApp({
      rateLimiters: {
        ENDPOINT_CREATION_RATE_LIMITER: new StubRateLimiter(
          new Error("unavailable"),
        ),
      },
    });

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.18" },
    });

    await expectHttpRateLimit(response, 503);
  });
});
