import type { EndpointId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import type { EventMetadataInsert } from "../../domain/event.js";
import { D1EndpointRepository } from "./endpoint-repository.js";
import { D1EventRepository } from "./event-repository.js";

function makeEvent(
  overrides: Partial<EventMetadataInsert> = {},
): EventMetadataInsert {
  return {
    id: "evt_d1_secret_race",
    endpoint_id: "ep_private" as EndpointId,
    received_at: "2026-07-05T12:00:00.000Z",
    method: "POST",
    ingest_path: "/ep_private/webhook",
    request_path: "/webhook",
    query_json: "{}",
    allowlist_headers_json: "{}",
    sensitive_header_names_json: "[]",
    content_type: null,
    content_length: null,
    user_agent: null,
    body_size: 7,
    body_sha256: "sha256",
    body_r2_key: "events/ep_private/body.raw",
    request_r2_key: "events/ep_private/request.json",
    secret_verification_status: "matched",
    matched_secret_id: "sec_revoked",
    created_at: "2026-07-05T12:00:00.000Z",
    ...overrides,
  };
}

class CreateEventD1Database {
  readonly queries: string[] = [];
  readonly bindings: unknown[][] = [];
  readonly activeSecretExists: boolean;

  constructor(options: { activeSecretExists?: boolean } = {}) {
    this.activeSecretExists = options.activeSecretExists ?? false;
  }

  prepare(query: string) {
    this.queries.push(query);

    return {
      bind: (...bindings: unknown[]) => {
        this.bindings.push(bindings);

        return {
          run: async () => {
            const matchedSecretId = bindings[17] as string | null;
            const checksMatchedSecret =
              query.includes("endpoint_secrets") &&
              query.includes("matched_secret_id") &&
              query.includes("revoked_at IS NULL");
            const checksNoActiveSecrets =
              query.includes("? IS NULL") &&
              query.includes("NOT EXISTS") &&
              query.includes("endpoint_secrets");
            const blockedByNewlyActiveSecret =
              matchedSecretId === null &&
              this.activeSecretExists &&
              checksNoActiveSecrets;

            return {
              meta: {
                changes:
                  (matchedSecretId !== null && checksMatchedSecret) ||
                  blockedByNewlyActiveSecret
                    ? 0
                    : 1,
              },
            };
          },
          first: async () => {
            if (query.includes("FROM endpoint_secrets")) {
              return this.activeSecretExists ? { id: "sec_new" } : null;
            }

            return { id: "ep_private" };
          },
        };
      },
    };
  }
}

describe("D1EventRepository", () => {
  it("projects only list and catch-up columns for every cursor mode", async () => {
    const projectedRow = {
      id: "evt_list_projection",
      endpoint_id: "ep_private",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      request_path: "/webhook",
      query_json: '{"source":"test"}',
      allowlist_headers_json: '{"content-type":"application/json"}',
      body_size: 7,
      body_sha256: "sha256",
      body_r2_key: "events/ep_private/body.raw",
      request_r2_key: "events/ep_private/request.json",
    };
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({ results: [projectedRow] }),
            };
          },
        };
      }
    })();
    const repository = new D1EventRepository(db as unknown as D1Database);

    await expect(
      repository.listEventsForEndpoint("ep_private" as EndpointId, {
        limit: 20,
      }),
    ).resolves.toEqual([projectedRow]);
    await expect(
      repository.listEventsForEndpoint("ep_private" as EndpointId, {
        limit: 10,
        after: "evt_after",
      }),
    ).resolves.toEqual([projectedRow]);
    await expect(
      repository.listEventsForEndpoint("ep_private" as EndpointId, {
        limit: 5,
        before: "evt_before",
      }),
    ).resolves.toEqual([projectedRow]);

    const expectedProjection =
      "SELECT id, endpoint_id, received_at, method, request_path, query_json, allowlist_headers_json, body_size, body_sha256, body_r2_key, request_r2_key";

    for (const query of db.queries) {
      expect(query.replaceAll(/\s+/g, " ").trim()).toContain(
        expectedProjection,
      );
      expect(query).not.toContain("SELECT *");
    }

    expect(db.queries[0]).toContain("ORDER BY sequence DESC LIMIT ?");
    expect(db.queries[1]).toContain("ORDER BY sequence ASC LIMIT ?");
    expect(db.queries[2]).toContain("ORDER BY sequence DESC LIMIT ?");
    expect(db.bindings).toEqual([
      ["ep_private", 20],
      ["ep_private", "ep_private", "evt_after", 10],
      ["ep_private", "ep_private", "evt_before", 5],
    ]);
  });

  it("requires a matched ingest secret to still be active before creating an event", async () => {
    const db = new CreateEventD1Database();
    const repository = new D1EventRepository(db as unknown as D1Database);

    await expect(repository.createEvent(makeEvent())).resolves.toEqual({
      status: "matched_secret_inactive",
    });
    expect(db.queries[0]).toContain("endpoint_secrets");
    expect(db.queries[0]).toContain("revoked_at IS NULL");
    expect(db.bindings[0]).toContain("sec_revoked");
  });

  it("rejects no-secret event creation when an active secret now exists", async () => {
    const db = new CreateEventD1Database({ activeSecretExists: true });
    const repository = new D1EventRepository(db as unknown as D1Database);

    await expect(
      repository.createEvent(
        makeEvent({
          secret_verification_status: "not_configured",
          matched_secret_id: null,
        }),
      ),
    ).resolves.toEqual({
      status: "active_secret_required",
    });
    expect(db.queries[0]).toContain("NOT EXISTS");
    expect(db.queries[0]).toContain("endpoint_secrets");
  });

  it("lists expired private event object keys without reading raw bodies", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          run: async () => ({ meta: { changes: 1 } }),
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({
                results: [
                  {
                    sequence: 12,
                    id: "evt_retention",
                    endpoint_id: "ep_private",
                    body_r2_key:
                      "events/ep_private/2026/07/03/evt_retention/body.raw",
                    request_r2_key:
                      "events/ep_private/2026/07/03/evt_retention/request.json",
                  },
                ],
              }),
            };
          },
        };
      }
    })();
    const repository = new D1EventRepository(db as unknown as D1Database);

    await expect(
      repository.listExpiredPrivateEventObjectKeys(
        new Date("2026-07-03T12:00:00.000Z"),
        { limit: 25, afterSequence: 10 },
      ),
    ).resolves.toEqual([
      {
        sequence: 12,
        eventId: "evt_retention",
        endpointId: "ep_private",
        bodyR2Key: "events/ep_private/2026/07/03/evt_retention/body.raw",
        requestR2Key: "events/ep_private/2026/07/03/evt_retention/request.json",
      },
    ]);
    expect(db.queries[0]).toContain("INNER JOIN endpoints");
    expect(db.queries[0]).toContain("endpoints.mode = 'private'");
    expect(db.queries[0]).not.toContain("request_json");
    expect(db.bindings[0]).toEqual(["2026-07-03T12:00:00.000Z", 10, 25]);
  });

  it("selects deleted event endpoint IDs before deleting retention rows", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          run: async () => ({ meta: { changes: 1 } }),
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({
                results: [{ id: "evt_delete", endpoint_id: "ep_private" }],
              }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      }
    })();
    const repository = new D1EventRepository(db as unknown as D1Database);

    await expect(repository.deleteEventsByIds(["evt_delete"])).resolves.toEqual(
      [
        {
          eventId: "evt_delete",
          endpointId: "ep_private",
        },
      ],
    );
    expect(db.queries[0]).toContain("SELECT id, endpoint_id");
    expect(db.queries[1]).toContain("DELETE FROM events");
    expect(db.bindings).toEqual([["evt_delete"], ["evt_delete"]]);
  });
});

describe("D1EndpointRepository cleanup methods", () => {
  it("creates private endpoints with a seven-day expiry and 1000-event limit", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);

    await expect(
      repository.createPrivateEndpoint({
        id: "ep_private" as EndpointId,
        accountId: "acct_mvp",
        name: "github-dev",
        now: new Date("2026-07-05T12:00:00.000Z"),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "ep_private",
        mode: "private",
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
    );
    expect(db.queries[0]).toContain("event_limit");
    expect(db.queries[0]).toContain("expires_at");
    expect(db.bindings[0]).toEqual([
      "ep_private",
      "acct_mvp",
      "github-dev",
      1000,
      "2026-07-12T12:00:00.000Z",
      "2026-07-05T12:00:00.000Z",
      "2026-07-05T12:00:00.000Z",
    ]);
  });

  it("reserves private event slots only below the configured limit and TTL", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);
    const now = new Date("2026-07-05T12:00:00.000Z");

    await expect(
      repository.reservePrivateEventSlot("ep_private" as EndpointId, 1000, now),
    ).resolves.toBe(true);

    expect(db.queries[0]).toContain("mode = 'private'");
    expect(db.queries[0]).toContain("event_count < ?");
    expect(db.queries[0]).toContain("expires_at > ?");
    expect(db.bindings[0]).toEqual([
      "ep_private",
      1000,
      "2026-07-05T12:00:00.000Z",
    ]);
  });

  it("does not reserve private event slots for expired endpoints", async () => {
    const db = new (class {
      prepare() {
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
          }),
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);

    await expect(
      repository.reservePrivateEventSlot(
        "ep_private_expired" as EndpointId,
        1000,
        new Date("2026-07-05T12:00:00.000Z"),
      ),
    ).resolves.toBe(false);
  });

  it("lists expired temporary endpoints and reconciles private event counts", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          run: async () => ({ meta: { changes: 1 } }),
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({
                results: [
                  {
                    id: "ep_expired",
                    account_id: null,
                    name: null,
                    mode: "temporary",
                    status: "active",
                    public_read: 1,
                    event_count: 1,
                    event_limit: 100,
                    expires_at: "2026-07-10T11:00:00.000Z",
                    created_at: "2026-07-09T11:00:00.000Z",
                    updated_at: "2026-07-09T11:00:00.000Z",
                  },
                ],
              }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);

    await expect(
      repository.listExpiredTemporaryEndpoints(
        new Date("2026-07-10T12:00:00.000Z"),
        { limit: 25 },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "ep_expired",
        mode: "temporary",
      }),
    ]);
    await repository.reconcilePrivateEndpointEventCounts();

    expect(db.queries[0]).toContain("mode = 'temporary'");
    expect(db.queries[0]).toContain("expires_at <= ?");
    expect(db.queries[1]).toContain("SELECT COUNT(*)");
    expect(db.queries[1]).toContain("WHERE mode = 'private'");
    expect(db.bindings).toEqual([["2026-07-10T12:00:00.000Z", 25]]);
  });

  it("lists active private endpoints using stored expires_at", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({ results: [] }),
            };
          },
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);

    await repository.listPrivateEndpoints(
      "acct_mvp",
      new Date("2026-07-10T12:00:00.000Z"),
    );

    expect(db.queries[0]).toContain("expires_at > ?");
    expect(db.bindings[0]).toEqual(["acct_mvp", "2026-07-10T12:00:00.000Z"]);
  });

  it("lists and deletes expired private endpoints for cleanup", async () => {
    const db = new (class {
      readonly queries: string[] = [];
      readonly bindings: unknown[][] = [];

      prepare(query: string) {
        this.queries.push(query);

        return {
          run: async () => ({ meta: { changes: 1 } }),
          bind: (...bindings: unknown[]) => {
            this.bindings.push(bindings);

            return {
              all: async () => ({
                results: [
                  {
                    id: "ep_private_expired",
                    account_id: "acct_mvp",
                    name: null,
                    mode: "private",
                    status: "active",
                    public_read: 0,
                    event_count: 1,
                    event_limit: 1000,
                    expires_at: "2026-07-10T11:00:00.000Z",
                    created_at: "2026-07-03T11:00:00.000Z",
                    updated_at: "2026-07-03T11:00:00.000Z",
                  },
                ],
              }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      }
    })();
    const repository = new D1EndpointRepository(db as unknown as D1Database);

    await expect(
      repository.listExpiredPrivateEndpoints(
        new Date("2026-07-10T12:00:00.000Z"),
        { limit: 25 },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "ep_private_expired",
        mode: "private",
      }),
    ]);
    await expect(
      repository.deletePrivateEndpoint("ep_private_expired" as EndpointId),
    ).resolves.toBe(true);

    expect(db.queries[0]).toContain("mode = 'private'");
    expect(db.queries[0]).toContain("expires_at <= ?");
    expect(db.queries[1]).toContain("DELETE FROM endpoints");
    expect(db.queries[1]).toContain("mode = 'private'");
    expect(db.bindings).toEqual([
      ["2026-07-10T12:00:00.000Z", 25],
      ["ep_private_expired"],
    ]);
  });
});
