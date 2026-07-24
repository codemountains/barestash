import type { EndpointId } from "@barestash/shared/ids";
import {
  PRIVATE_ENDPOINT_EVENT_LIMIT,
  PRIVATE_ENDPOINT_TTL_SECONDS,
  TEMPORARY_ENDPOINT_EVENT_LIMIT,
  TEMPORARY_ENDPOINT_TTL_SECONDS,
} from "@barestash/shared/limits";
import {
  type AccountId,
  type CreatePrivateEndpointInput,
  type CreateTemporaryEndpointInput,
  type EndpointRow,
  endpointRowToStoredEndpoint,
  type StoredEndpoint,
} from "../../domain/endpoint.js";
import type { EndpointRepository } from "../../domain/ports.js";

/** @public */
export class D1EndpointRepository implements EndpointRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async createTemporaryEndpoint(
    input: CreateTemporaryEndpointInput,
  ): Promise<StoredEndpoint> {
    const createdAt = input.now.toISOString();
    const expiresAt = new Date(
      input.now.getTime() + TEMPORARY_ENDPOINT_TTL_SECONDS * 1000,
    ).toISOString();

    await this.#db
      .prepare(
        `INSERT INTO endpoints (
          id,
          account_id,
          name,
          mode,
          status,
          public_read,
          event_limit,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, NULL, ?, 'temporary', 'active', 1, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.name,
        TEMPORARY_ENDPOINT_EVENT_LIMIT,
        expiresAt,
        createdAt,
        createdAt,
      )
      .run();

    return {
      id: input.id,
      name: input.name,
      mode: "temporary",
      status: "active",
      public_read: true,
      event_count: 0,
      event_limit: TEMPORARY_ENDPOINT_EVENT_LIMIT,
      expires_at: expiresAt,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  async createPrivateEndpoint(
    input: CreatePrivateEndpointInput,
  ): Promise<StoredEndpoint> {
    const createdAt = input.now.toISOString();
    const expiresAt = new Date(
      input.now.getTime() + PRIVATE_ENDPOINT_TTL_SECONDS * 1000,
    ).toISOString();

    await this.#db
      .prepare(
        `INSERT INTO endpoints (
          id,
          account_id,
          name,
          mode,
          status,
          public_read,
          event_limit,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'private', 'active', 0, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.accountId,
        input.name,
        PRIVATE_ENDPOINT_EVENT_LIMIT,
        expiresAt,
        createdAt,
        createdAt,
      )
      .run();

    return {
      id: input.id,
      account_id: input.accountId,
      name: input.name,
      mode: "private",
      status: "active",
      public_read: false,
      event_count: 0,
      event_limit: PRIVATE_ENDPOINT_EVENT_LIMIT,
      expires_at: expiresAt,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  async listActiveTemporaryEndpoints(now: Date): Promise<StoredEndpoint[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoints
         WHERE mode = 'temporary'
           AND status = 'active'
           AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .bind(now.toISOString())
      .all<EndpointRow>();

    return result.results.map(endpointRowToStoredEndpoint);
  }

  async listExpiredTemporaryEndpoints(
    now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoints
         WHERE mode = 'temporary'
           AND (
             status = 'expired'
             OR expires_at <= ?
           )
         ORDER BY expires_at ASC, created_at ASC
         LIMIT ?`,
      )
      .bind(now.toISOString(), options.limit)
      .all<EndpointRow>();

    return result.results.map(endpointRowToStoredEndpoint);
  }

  async listPrivateEndpoints(
    accountId: AccountId,
    now: Date,
  ): Promise<StoredEndpoint[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoints
         WHERE mode = 'private'
           AND status = 'active'
           AND account_id = ?
           AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .bind(accountId, now.toISOString())
      .all<EndpointRow>();

    return result.results.map(endpointRowToStoredEndpoint);
  }

  async findEndpoint(id: EndpointId): Promise<StoredEndpoint | null> {
    const row = await this.#db
      .prepare("SELECT * FROM endpoints WHERE id = ?")
      .bind(id)
      .first<EndpointRow>();

    return row === null ? null : endpointRowToStoredEndpoint(row);
  }

  async reserveTemporaryEventSlot(
    id: EndpointId,
    limit: number,
  ): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = event_count + 1
         WHERE id = ?
           AND mode = 'temporary'
           AND status = 'active'
           AND event_count < ?`,
      )
      .bind(id, limit)
      .run();

    return result.meta.changes === 1;
  }

  async releaseTemporaryEventSlot(id: EndpointId): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = MAX(event_count - 1, 0)
         WHERE id = ?`,
      )
      .bind(id)
      .run();
  }

  async incrementPrivateEndpointEventCount(id: EndpointId): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = event_count + 1
         WHERE id = ?
           AND mode = 'private'
           AND status = 'active'`,
      )
      .bind(id)
      .run();

    return result.meta.changes === 1;
  }

  async reservePrivateEventSlot(
    id: EndpointId,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = event_count + 1
         WHERE id = ?
           AND mode = 'private'
           AND status = 'active'
           AND event_count < ?
           AND expires_at > ?`,
      )
      .bind(id, limit, now.toISOString())
      .run();

    return result.meta.changes === 1;
  }

  async releasePrivateEndpointEventCount(id: EndpointId): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = MAX(event_count - 1, 0)
         WHERE id = ?
           AND mode = 'private'`,
      )
      .bind(id)
      .run();
  }

  async reconcilePrivateEndpointEventCounts(): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE endpoints
         SET event_count = (
           SELECT COUNT(*)
           FROM events
           WHERE events.endpoint_id = endpoints.id
         )
         WHERE mode = 'private'`,
      )
      .run();
  }

  async disableEndpoint(
    id: EndpointId,
    accountId: AccountId,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `UPDATE endpoints
         SET status = 'disabled', updated_at = ?
         WHERE id = ?
           AND account_id = ?
           AND mode = 'private'
           AND status = 'active'`,
      )
      .bind(updatedAt, id, accountId)
      .run();

    return result.meta.changes === 1;
  }

  async deleteEndpoint(id: EndpointId, accountId: AccountId): Promise<void> {
    await this.#db
      .prepare(
        `DELETE FROM endpoints
         WHERE id = ?
           AND account_id = ?
           AND mode = 'private'`,
      )
      .bind(id, accountId)
      .run();
  }

  async deleteTemporaryEndpoint(id: EndpointId): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `DELETE FROM endpoints
         WHERE id = ?
           AND mode = 'temporary'`,
      )
      .bind(id)
      .run();

    return result.meta.changes === 1;
  }

  async listExpiredPrivateEndpoints(
    now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoints
         WHERE mode = 'private'
           AND (
             status = 'expired'
             OR expires_at <= ?
           )
         ORDER BY expires_at ASC, created_at ASC
         LIMIT ?`,
      )
      .bind(now.toISOString(), options.limit)
      .all<EndpointRow>();

    return result.results.map(endpointRowToStoredEndpoint);
  }

  async deletePrivateEndpoint(id: EndpointId): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `DELETE FROM endpoints
         WHERE id = ?
           AND mode = 'private'`,
      )
      .bind(id)
      .run();

    return result.meta.changes === 1;
  }
}
