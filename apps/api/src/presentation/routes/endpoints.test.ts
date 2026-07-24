import type {
  EndpointSecretCreateResponse,
  EndpointSecretListResponse,
} from "@barestash/shared/endpoint-secrets";
import type { EndpointResponse } from "@barestash/shared/endpoints";
import type { EndpointId, SecretId, TokenId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import type { CreateApiAppOptions } from "../../container.js";
import type { EndpointRepository } from "../../domain/ports.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../../infrastructure/in-memory/endpoint-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  fixedNow,
  makeApp,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  seedTestPersonalAccessToken,
  testTokenId,
  unusedEndpointEventSlots,
} from "../../testing/helpers.js";

async function createAuthenticatedApiApp(
  tokenId: TokenId,
  seed: string,
  options: CreateApiAppOptions,
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

describe("endpoint API routes", () => {
  it("uses in-memory storage through the test composition root", async () => {
    const app = createTestApiApp({});
    const createResponse = await app.request(
      "https://api.example.com/v1/endpoints",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: "temporary",
        }),
      },
    );
    const createBody = (await createResponse.json()) as EndpointResponse;

    expect(createResponse.status).toBe(201);

    const showResponse = await app.request(
      `https://api.example.com/v1/endpoints/${createBody.endpoint.id}`,
    );

    expect(showResponse.status).toBe(200);
    expect(await showResponse.json()).toEqual({
      endpoint: expect.objectContaining({
        id: createBody.endpoint.id,
        mode: "temporary",
      }),
    });
  });

  it("creates temporary endpoints without authentication", async () => {
    const app = makeApp();

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporary",
        name: "stripe-test",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      endpoint: {
        id: "ep_01JDEF",
        name: "stripe-test",
        mode: "temporary",
        status: "active",
        public_read: true,
        event_count: 0,
        event_limit: 100,
        expires_at: "2026-07-06T12:00:00.000Z",
        created_at: "2026-07-05T12:00:00.000Z",
        updated_at: "2026-07-05T12:00:00.000Z",
        ingest_url: "https://ingest.example.com/ep_01JDEF",
      },
    });
  });

  it("rejects unknown endpoint modes", async () => {
    const app = makeApp();

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporay",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: 'Endpoint mode must be "private" or "temporary".',
      },
    });
  });

  it("rejects endpoint names that are not strings", async () => {
    const app = makeApp();

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporary",
        name: 123,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Endpoint name must be a string.",
      },
    });
  });

  it.each([
    null,
    [],
    "temporary",
    123,
    true,
  ])("rejects non-object endpoint request bodies: %j", async (body) => {
    const app = makeApp();

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be a JSON object.",
      },
    });
  });

  it("maps endpoint persistence failures to d1_write_failed", async () => {
    const repository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("D1 insert failed");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint() {
        return null;
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => fixedNow,
      generateEndpointId: () => "ep_01JDEF",
    });

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporary",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "d1_write_failed",
        message: "Failed to create endpoint metadata.",
      },
    });
  });

  it("requires authentication for endpoint list until private ownership is implemented", async () => {
    const app = makeApp();

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporary",
      }),
    });

    const listResponse = await app.request(
      "https://api.example.com/v1/endpoints",
    );
    expect(listResponse.status).toBe(401);
    expect(await listResponse.json()).toEqual({
      error: {
        code: "not_authenticated",
        message: "Authentication is required.",
      },
    });
  });

  it("shows active temporary endpoint metadata by public URL ID", async () => {
    const app = makeApp();

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "temporary",
      }),
    });

    const showResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF",
    );
    expect(showResponse.status).toBe(200);
    expect(await showResponse.json()).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_01JDEF",
        public_read: true,
        event_count: 0,
      }),
    });
  });

  it("maps endpoint read failures to a structured internal_error", async () => {
    const repository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("not used");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint() {
        throw new Error("D1 read failed");
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => fixedNow,
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read endpoint metadata.",
      },
    });
  });

  it("does not expose disabled temporary endpoint metadata", async () => {
    const repository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("not used");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint(id: EndpointId) {
        return {
          id,
          name: null,
          mode: "temporary",
          status: "disabled",
          public_read: true,
          event_count: 0,
          event_limit: 100,
          expires_at: "2026-07-06T12:00:00.000Z",
          created_at: "2026-07-05T12:00:00.000Z",
          updated_at: "2026-07-05T12:00:00.000Z",
        };
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => fixedNow,
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_disabled",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_disabled",
      },
    });
  });

  it("maps expired temporary endpoint status to endpoint_expired", async () => {
    const repository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("not used");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint(id: EndpointId) {
        return {
          id,
          name: null,
          mode: "temporary",
          status: "expired",
          public_read: true,
          event_count: 0,
          event_limit: 100,
          expires_at: "2026-07-06T12:00:00.000Z",
          created_at: "2026-07-05T12:00:00.000Z",
          updated_at: "2026-07-05T12:00:00.000Z",
        };
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => fixedNow,
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_expired",
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_expired",
      },
    });
  });

  it("requires authentication for private endpoint metadata until token auth is implemented", async () => {
    const repository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("not used");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint(id: EndpointId) {
        return {
          id,
          name: "github-dev",
          mode: "private",
          status: "active",
          public_read: false,
          event_count: 0,
          event_limit: null,
          expires_at: "2026-07-12T12:00:00.000Z",
          created_at: "2026-07-05T12:00:00.000Z",
          updated_at: "2026-07-05T12:00:00.000Z",
        };
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => fixedNow,
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_private",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "not_authenticated",
        message: "Authentication is required.",
      },
    });
  });

  it("returns structured errors for malformed JSON and invalid endpoint IDs", async () => {
    const app = makeApp();

    const malformedJsonResponse = await app.request(
      "https://api.example.com/v1/endpoints",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      },
    );

    expect(malformedJsonResponse.status).toBe(400);
    expect(await malformedJsonResponse.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be valid JSON.",
      },
    });

    const invalidIdResponse = await app.request(
      "https://api.example.com/v1/endpoints/not-an-endpoint",
    );

    expect(invalidIdResponse.status).toBe(404);
    expect(await invalidIdResponse.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: not-an-endpoint",
      },
    });
  });

  it("maps expired temporary endpoints to endpoint_expired", async () => {
    const repository = new InMemoryEndpointRepository();
    const app = createTestApiApp({
      endpointRepository: repository,
      now: () => new Date("2026-07-07T12:00:00.000Z"),
      generateEndpointId: () => "ep_01JDEF",
    });

    await repository.createTemporaryEndpoint({
      id: "ep_01JDEF",
      name: null,
      now: fixedNow,
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF",
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_01JDEF",
      },
    });
  });

  it("creates private endpoints with seven-day expiry and a 1000-event limit", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("owner"),
      "owner",
      {
        endpointRepository: new InMemoryEndpointRepository(),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
        generateEndpointId: () => "ep_private",
      },
    );

    const response = await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: "private", name: "github-dev" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_private",
        name: "github-dev",
        mode: "private",
        public_read: false,
        event_count: 0,
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
    });
  });

  it("hides expired private endpoints from authenticated endpoint lists", async () => {
    const repository = new InMemoryEndpointRepository();
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("owner"),
      "owner",
      {
        endpointRepository: repository,
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => new Date("2026-07-12T12:00:00.000Z"),
        generateEndpointId: () => "ep_private",
      },
    );

    await repository.createPrivateEndpoint({
      id: "ep_private",
      accountId: "acc_test_owner",
      name: null,
      now: fixedNow,
    });

    const response = await app.request("https://api.example.com/v1/endpoints", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ endpoints: [] });
  });

  it("returns endpoint_not_found for unknown endpoints", async () => {
    const app = makeApp();

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_missing",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_missing",
      },
    });
  });

  it("creates, lists, revokes, and rotates private endpoint ingest secrets without exposing raw secret after creation", async () => {
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("owner"),
      "owner",
      {
        endpointRepository: new InMemoryEndpointRepository(),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
        generateEndpointId: () => "ep_private",
        generateSecretId: (() => {
          const ids: SecretId[] = ["sec_old", "sec_new"];
          return () => ids.shift() ?? "sec_extra";
        })(),
        generateEndpointSecret: (() => {
          const secrets = ["old-secret", "new-secret"];
          return () => secrets.shift() ?? "extra-secret";
        })(),
      },
    );
    const authHeaders = { authorization: `Bearer ${token}` };

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ mode: "private" }),
    });

    const createResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      { method: "POST", headers: authHeaders },
    );
    const created =
      (await createResponse.json()) as EndpointSecretCreateResponse;

    expect(createResponse.status).toBe(201);
    expect(created).toEqual({
      endpoint_secret: {
        id: "sec_old",
        endpoint_id: "ep_private",
        status: "active",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      },
      secret: "old-secret",
    });

    const secondCreateResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      { method: "POST", headers: authHeaders },
    );
    expect(secondCreateResponse.status).toBe(201);

    const listResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      { headers: authHeaders },
    );
    const list = (await listResponse.json()) as EndpointSecretListResponse;

    expect(listResponse.status).toBe(200);
    expect(list.endpoint_secrets.map((secret) => secret.id).sort()).toEqual([
      "sec_new",
      "sec_old",
    ]);
    expect(JSON.stringify(list)).not.toContain("old-secret");
    expect(JSON.stringify(list)).not.toContain("new-secret");

    const revokeResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets/sec_old",
      { method: "DELETE", headers: authHeaders },
    );

    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toEqual({
      endpoint_secret: {
        id: "sec_old",
        endpoint_id: "ep_private",
        status: "revoked",
        created_at: "2026-07-05T12:00:00.000Z",
        last_used_at: null,
        revoked_at: "2026-07-05T12:00:00.000Z",
      },
    });

    const temporarySecretResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_temp/secrets",
      { method: "POST", headers: authHeaders },
    );
    expect(temporarySecretResponse.status).toBe(404);
  });

  it("deletes private endpoints with D1 and R2 cascade while rejecting temporary endpoint deletion", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new RecordingRequestBodyStore();
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("delete"),
      "delete",
      {
        endpointRepository,
        eventRepository,
        requestBodyStore: bodyStore,
        now: () => fixedNow,
        generateEndpointId: (() => {
          const ids: EndpointId[] = ["ep_private", "ep_temp"];
          return () => ids.shift() ?? "ep_extra";
        })(),
        generateEventId: () => "evt_delete",
      },
    );
    const authHeaders = { authorization: `Bearer ${token}` };

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ mode: "private" }),
    });
    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "temporary" }),
    });
    await app.request("https://ingest.example.com/ep_private/webhook", {
      method: "POST",
      body: "delete me",
    });

    const temporaryDeleteResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_temp",
      { method: "DELETE", headers: authHeaders },
    );
    expect(temporaryDeleteResponse.status).toBe(400);
    expect(await temporaryDeleteResponse.json()).toEqual({
      error: {
        code: "temporary_endpoint_delete_not_supported",
        message:
          "Cannot delete temporary endpoint: ep_temp. Temporary endpoints expire automatically after 24 hours.",
      },
    });

    const deleteResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private",
      { method: "DELETE", headers: authHeaders },
    );

    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_private",
        mode: "private",
      }),
      deleted_events: 1,
      deleted_body_objects: 2,
    });
    expect(bodyStore.deletes).toEqual([
      "events/ep_private/2026/07/05/evt_delete/body.raw",
      "events/ep_private/2026/07/05/evt_delete/request.json",
    ]);

    const showDeletedResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private",
      { headers: authHeaders },
    );
    expect(showDeletedResponse.status).toBe(404);

    const eventResponse = await app.request(
      "https://api.example.com/v1/events/evt_delete",
      { headers: authHeaders },
    );
    expect(eventResponse.status).toBe(404);
  });

  it("keeps private endpoint deletion retryable when R2 cleanup fails", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new (class extends RecordingRequestBodyStore {
      failNextDelete = true;

      async delete(key: string): Promise<void> {
        if (this.failNextDelete) {
          this.failNextDelete = false;
          throw new Error("R2 delete failed");
        }

        await super.delete(key);
      }
    })();
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("retrydelete"),
      "retrydelete",
      {
        endpointRepository,
        eventRepository,
        requestBodyStore: bodyStore,
        now: () => fixedNow,
        generateEndpointId: () => "ep_retry",
        generateEventId: () => "evt_retry_delete",
      },
    );
    const authHeaders = { authorization: `Bearer ${token}` };

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ mode: "private" }),
    });
    await app.request("https://ingest.example.com/ep_retry/webhook", {
      method: "POST",
      body: "retry cleanup",
    });

    const firstDeleteResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_retry",
      { method: "DELETE", headers: authHeaders },
    );
    expect(firstDeleteResponse.status).toBe(500);
    expect(await firstDeleteResponse.json()).toEqual({
      error: {
        code: "r2_write_failed",
        message: "Failed to delete request body objects.",
      },
    });

    const hiddenEventsResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_retry/events",
      { headers: authHeaders },
    );
    expect(hiddenEventsResponse.status).toBe(404);

    const retryDeleteResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_retry",
      { method: "DELETE", headers: authHeaders },
    );

    expect(retryDeleteResponse.status).toBe(200);
    expect(await retryDeleteResponse.json()).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_retry",
        mode: "private",
      }),
      deleted_events: 1,
      deleted_body_objects: 2,
    });
  });

  it("deletes private endpoint R2 objects in bounded pages and batches", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const eventRepository = new (class extends RecordingEventRepository {
      readonly objectKeyListOptions: {
        limit: number;
        afterSequence?: number;
      }[] = [];

      async listEventObjectKeysForEndpoint(
        endpointId: EndpointId,
        options: { limit: number; afterSequence?: number },
      ) {
        this.objectKeyListOptions.push(options);

        return super.listEventObjectKeysForEndpoint(endpointId, options);
      }
    })();
    const bodyStore = new (class extends RecordingRequestBodyStore {
      activeDeletes = 0;
      maxActiveDeletes = 0;

      async delete(key: string): Promise<void> {
        this.activeDeletes += 1;
        this.maxActiveDeletes = Math.max(
          this.maxActiveDeletes,
          this.activeDeletes,
        );

        try {
          await Promise.resolve();
          await super.delete(key);
        } finally {
          this.activeDeletes -= 1;
        }
      }

      async deleteMany(keys: string[]): Promise<void> {
        this.activeDeletes += 1;
        this.maxActiveDeletes = Math.max(
          this.maxActiveDeletes,
          this.activeDeletes,
        );
        this.deleteManyBatches.push(keys);

        try {
          await Promise.resolve();

          for (const key of keys) {
            this.deletes.push(key);
            this.objects.delete(key);
          }
        } finally {
          this.activeDeletes -= 1;
        }
      }
    })();
    const { app, token } = await createAuthenticatedApiApp(
      testTokenId("manydelete"),
      "manydelete",
      {
        endpointRepository,
        eventRepository,
        requestBodyStore: bodyStore,
        now: () => fixedNow,
        generateEndpointId: () => "ep_many",
        generateEventId: (() => {
          let next = 0;

          return () => `evt_many_${String(next++).padStart(3, "0")}`;
        })(),
      },
    );
    const authHeaders = { authorization: `Bearer ${token}` };

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ mode: "private" }),
    });

    for (let index = 0; index < 26; index += 1) {
      await app.request(`https://ingest.example.com/ep_many/webhook/${index}`, {
        method: "POST",
        body: `delete ${index}`,
      });
    }

    const deleteResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_many",
      { method: "DELETE", headers: authHeaders },
    );

    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      endpoint: expect.objectContaining({
        id: "ep_many",
        mode: "private",
      }),
      deleted_events: 26,
      deleted_body_objects: 52,
    });
    expect(bodyStore.deletes).toHaveLength(52);
    expect(bodyStore.deleteManyBatches.map((batch) => batch.length)).toEqual([
      25, 25, 2,
    ]);
    expect(bodyStore.maxActiveDeletes).toBe(1);
    expect(eventRepository.objectKeyListOptions).toEqual([
      { limit: 25, afterSequence: undefined },
      { limit: 25, afterSequence: 25 },
      { limit: 25, afterSequence: 26 },
    ]);
  });
});
