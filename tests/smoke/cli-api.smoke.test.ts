import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CliOutputTimeoutError,
  getFreePort,
  runBarestashCli,
  type SmokeApiServer,
  startBarestashCli,
  startSmokeApiServer,
  waitForCliOutput,
} from "./helpers.js";

type CreatedEndpoint = {
  id: string;
  ingest_url: string;
  mode: string;
};

async function createTemporaryEndpoint(
  apiUrl: string,
): Promise<CreatedEndpoint> {
  const createResult = await runBarestashCli(
    ["endpoints", "create", "--temporary", "--json"],
    {
      BARESTASH_API_URL: apiUrl,
    },
  );

  expect(createResult.exitCode, createResult.stderr).toBe(0);

  const createOutput = JSON.parse(createResult.stdout) as {
    endpoint: CreatedEndpoint;
  };

  expect(createOutput.endpoint.mode).toBe("temporary");
  expect(createOutput.endpoint.id).toMatch(/^ep_/);
  expect(createOutput.endpoint.ingest_url).toContain(createOutput.endpoint.id);

  return createOutput.endpoint;
}

async function ingestWebhook(
  ingestUrl: string,
  endpointId: string,
  payload: unknown,
  path = "smoke-test",
  query = "source=e2e",
): Promise<string> {
  const response = await fetch(`${ingestUrl}/${path}?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(204);

  const eventId = response.headers.get("x-barestash-event-id");
  expect(eventId).toMatch(/^evt_/);
  expect(response.headers.get("x-barestash-endpoint-id")).toBe(endpointId);

  return eventId as string;
}

describe("CLI smoke E2E", () => {
  let apiServer: SmokeApiServer | undefined;
  let apiUrl: string;
  let ownerPat: string;

  beforeAll(async () => {
    const port = await getFreePort();
    apiServer = await startSmokeApiServer(port);
    apiUrl = apiServer.baseUrl;
    ownerPat = apiServer.ownerPat;
  }, 180_000);

  afterAll(async () => {
    if (apiServer !== undefined) {
      await apiServer.stop();
    }
  }, 30_000);

  it("creates a temporary endpoint, ingests a webhook, and reads it back through the CLI", async () => {
    const webhookPayload = {
      smoke: true,
      case: "cli-e2e",
    };
    const webhookPath = "smoke-test";
    const webhookQuery = "source=e2e";

    const endpoint = await createTemporaryEndpoint(apiUrl);
    const eventId = await ingestWebhook(
      endpoint.ingest_url,
      endpoint.id,
      webhookPayload,
      webhookPath,
      webhookQuery,
    );

    const latestResult = await runBarestashCli(
      ["events", "latest", "--endpoint", endpoint.id, "--json"],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    expect(latestResult.exitCode).toBe(0);

    const latestOutput = JSON.parse(latestResult.stdout) as {
      event: {
        id: string;
        endpoint_id: string;
        method?: string;
        request: {
          method: string;
          request_path: string;
          query: Record<string, string>;
          headers: Record<string, string>;
        };
      };
      body: typeof webhookPayload;
    };

    expect(latestOutput.event).toBeTruthy();
    expect(latestOutput.event.endpoint_id).toBe(endpoint.id);
    expect(latestOutput.event.id).toBe(eventId);
    expect(latestOutput.event.request.method).toBe("POST");
    expect(latestOutput.event.request.request_path).toBe(`/${webhookPath}`);
    expect(latestOutput.event.request.query).toEqual({ source: "e2e" });
    expect(latestOutput.event.request.headers["content-type"]).toBe(
      "application/json",
    );
    expect(latestOutput.body).toEqual(webhookPayload);
  }, 60_000);

  it("lists and shows a captured event through the CLI", async () => {
    const webhookPayload = {
      smoke: true,
      case: "list-show",
    };

    const endpoint = await createTemporaryEndpoint(apiUrl);
    const eventId = await ingestWebhook(
      endpoint.ingest_url,
      endpoint.id,
      webhookPayload,
    );

    const listResult = await runBarestashCli(
      ["events", "list", "--endpoint", endpoint.id, "--json"],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    expect(listResult.exitCode).toBe(0);

    const listOutput = JSON.parse(listResult.stdout) as {
      events: Array<{
        id: string;
        endpoint_id: string;
        method: string;
        request_path: string;
      }>;
    };

    expect(listOutput.events.length).toBeGreaterThanOrEqual(1);
    expect(listOutput.events.some((event) => event.id === eventId)).toBe(true);
    expect(
      listOutput.events.find((event) => event.id === eventId)?.endpoint_id,
    ).toBe(endpoint.id);

    const showResult = await runBarestashCli(
      ["events", "show", eventId, "--json"],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    expect(showResult.exitCode).toBe(0);

    const showOutput = JSON.parse(showResult.stdout) as {
      event: {
        id: string;
        endpoint_id: string;
        request: {
          method: string;
          request_path: string;
        };
      };
      body: typeof webhookPayload;
    };

    expect(showOutput.event.id).toBe(eventId);
    expect(showOutput.event.endpoint_id).toBe(endpoint.id);
    expect(showOutput.event.request.method).toBe("POST");
    expect(showOutput.body).toEqual(webhookPayload);
  }, 60_000);

  it("tails historical and live events through the CLI", async () => {
    const firstPayload = {
      smoke: true,
      case: "tail-historical",
    };
    const secondPayload = {
      smoke: true,
      case: "tail-live",
    };

    const endpoint = await createTemporaryEndpoint(apiUrl);
    const firstEventId = await ingestWebhook(
      endpoint.ingest_url,
      endpoint.id,
      firstPayload,
      "tail-a",
    );

    const cli = startBarestashCli(
      [
        "events",
        "tail",
        "--endpoint",
        endpoint.id,
        "--last",
        "1",
        "--body",
        "--poll-interval",
        "500ms",
      ],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    try {
      await waitForCliOutput(
        cli,
        (stdout) =>
          stdout.includes(firstEventId) && stdout.includes("tail-historical"),
        20_000,
      );

      const secondEventId = await ingestWebhook(
        endpoint.ingest_url,
        endpoint.id,
        secondPayload,
        "tail-b",
      );

      await waitForCliOutput(
        cli,
        (stdout) =>
          stdout.includes(secondEventId) && stdout.includes("tail-live"),
        20_000,
      );
    } finally {
      await cli.stop();
    }
  }, 90_000);

  it("streams a live ingested event as JSONL through the CLI", async () => {
    const endpoint = await createTemporaryEndpoint(apiUrl);
    const cli = startBarestashCli(
      ["events", "stream", "--endpoint", endpoint.id],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    try {
      // SSE has no catch-up without Last-Event-ID. Retry ingest until the
      // subscription is live enough to fan out an event.
      const deadline = Date.now() + 60_000;
      let matchedEventId: string | undefined;
      let matchedStdout: string | undefined;
      let attempt = 0;

      while (Date.now() < deadline) {
        attempt += 1;
        const webhookPayload = {
          smoke: true,
          case: "stream-live",
          attempt,
        };

        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const eventId = await ingestWebhook(
          endpoint.ingest_url,
          endpoint.id,
          webhookPayload,
          "stream-test",
        );

        try {
          matchedStdout = await waitForCliOutput(
            cli,
            (output) =>
              output
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .some((line) => {
                  try {
                    return (JSON.parse(line) as { id?: string }).id === eventId;
                  } catch {
                    return false;
                  }
                }),
            5_000,
          );
          matchedEventId = eventId;
          break;
        } catch (error) {
          // Only retry when the subscription may not be ready yet.
          if (!(error instanceof CliOutputTimeoutError)) {
            throw error;
          }
        }
      }

      expect(matchedEventId).toBeDefined();
      expect(matchedStdout).toBeDefined();

      const payloadLine = (matchedStdout as string)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .find((line) => {
          try {
            return (JSON.parse(line) as { id?: string }).id === matchedEventId;
          } catch {
            return false;
          }
        });

      expect(payloadLine).toBeDefined();

      const payload = JSON.parse(payloadLine as string) as {
        id: string;
        endpoint_id: string;
        request: {
          method: string;
          path: string;
        };
        body: {
          smoke: boolean;
          case: string;
          attempt: number;
        };
      };

      expect(payload.id).toBe(matchedEventId);
      expect(payload.endpoint_id).toBe(endpoint.id);
      expect(payload.request.method).toBe("POST");
      expect(payload.request.path).toBe("/stream-test");
      expect(payload.body.smoke).toBe(true);
      expect(payload.body.case).toBe("stream-live");
      expect(payload.body.attempt).toBeGreaterThanOrEqual(1);
    } finally {
      await cli.stop();
    }
  }, 90_000);

  it("creates a private endpoint with token auth, ingest secret, and authenticated event read", async () => {
    const webhookPayload = {
      smoke: true,
      case: "private-auth",
    };

    const tokenResult = await runBarestashCli(
      ["tokens", "create", "--name", "smoke-private", "--json"],
      {
        BARESTASH_API_URL: apiUrl,
        BARESTASH_TOKEN: ownerPat,
      },
    );

    expect(tokenResult.exitCode, tokenResult.stderr).toBe(0);

    const tokenOutput = JSON.parse(tokenResult.stdout) as {
      id: string;
      token: string;
    };

    expect(tokenOutput.id).toMatch(/^tok_/);
    expect(tokenOutput.token.length).toBeGreaterThan(0);

    const apiToken = tokenOutput.token;
    const authEnv = {
      BARESTASH_API_URL: apiUrl,
      BARESTASH_TOKEN: apiToken,
    };

    const createResult = await runBarestashCli(
      ["endpoints", "create", "--private", "--json"],
      authEnv,
    );

    expect(createResult.exitCode).toBe(0);

    const createOutput = JSON.parse(createResult.stdout) as {
      endpoint: CreatedEndpoint;
    };

    expect(createOutput.endpoint.mode).toBe("private");
    expect(createOutput.endpoint.id).toMatch(/^ep_/);
    expect(createOutput.endpoint.ingest_url).toContain(
      createOutput.endpoint.id,
    );

    const secretResult = await runBarestashCli(
      [
        "endpoints",
        "secrets",
        "create",
        "--endpoint",
        createOutput.endpoint.id,
        "--json",
      ],
      authEnv,
    );

    expect(secretResult.exitCode).toBe(0);

    const secretOutput = JSON.parse(secretResult.stdout) as {
      endpoint_secret: { id: string };
      secret: string;
    };

    expect(secretOutput.endpoint_secret.id).toMatch(/^sec_/);
    expect(secretOutput.secret.length).toBeGreaterThan(0);

    const ingestUrl = `${createOutput.endpoint.ingest_url}/private-smoke?source=e2e`;
    const unauthorizedIngest = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(webhookPayload),
    });

    expect(unauthorizedIngest.status).toBe(401);

    const authorizedIngest = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-barestash-secret": secretOutput.secret,
      },
      body: JSON.stringify(webhookPayload),
    });

    expect(authorizedIngest.status).toBe(204);

    const eventId = authorizedIngest.headers.get("x-barestash-event-id");
    expect(eventId).toMatch(/^evt_/);
    expect(authorizedIngest.headers.get("x-barestash-endpoint-id")).toBe(
      createOutput.endpoint.id,
    );

    const unauthenticatedLatest = await runBarestashCli(
      ["events", "latest", "--endpoint", createOutput.endpoint.id, "--json"],
      {
        BARESTASH_API_URL: apiUrl,
      },
    );

    expect(unauthenticatedLatest.exitCode).not.toBe(0);
    expect(unauthenticatedLatest.stderr).toMatch(/Authentication is required/i);
    expect(unauthenticatedLatest.stderr).toContain("barestash auth login");

    const latestResult = await runBarestashCli(
      ["events", "latest", "--endpoint", createOutput.endpoint.id, "--json"],
      authEnv,
    );

    expect(latestResult.exitCode).toBe(0);

    const latestOutput = JSON.parse(latestResult.stdout) as {
      event: {
        id: string;
        endpoint_id: string;
        request: {
          method: string;
          request_path: string;
        };
      };
      body: typeof webhookPayload;
    };

    expect(latestOutput.event.id).toBe(eventId);
    expect(latestOutput.event.endpoint_id).toBe(createOutput.endpoint.id);
    expect(latestOutput.event.request.method).toBe("POST");
    expect(latestOutput.event.request.request_path).toBe("/private-smoke");
    expect(latestOutput.body).toEqual(webhookPayload);

    const mcpResponse = await fetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
    expect(await mcpResponse.text()).toContain("list_endpoints");

    const revokeResult = await runBarestashCli(
      ["tokens", "revoke", tokenOutput.id, "--yes"],
      {
        BARESTASH_API_URL: apiUrl,
        BARESTASH_TOKEN: ownerPat,
      },
    );
    expect(revokeResult.exitCode, revokeResult.stderr).toBe(0);
    const revokedAccount = await fetch(`${apiUrl}/v1/account`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(revokedAccount.status).toBe(401);
  }, 90_000);
});
