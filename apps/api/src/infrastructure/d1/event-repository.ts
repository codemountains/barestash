import type { EndpointId, EventId } from "@barestash/shared/ids";
import type {
  EventListRecord,
  EventListRow,
  EventMetadataInsert,
  EventRow,
} from "../../domain/event.js";
import {
  eventListRowToRecord,
  eventRowToMetadataInsert,
} from "../../domain/event.js";
import type { EventRepository } from "../../domain/ports.js";
import {
  bindInsertEventWithGuards,
  INSERT_EVENT_WITH_GUARDS_SQL,
  resolveFailedCreateEventResult,
} from "./event-insert.js";

/** @public */
export class D1EventRepository implements EventRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async countEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    const row = await this.#db
      .prepare("SELECT COUNT(*) AS count FROM events WHERE endpoint_id = ?")
      .bind(endpointId)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  async createEvent(
    input: EventMetadataInsert,
  ): Promise<import("../../domain/ports.js").CreateEventResult> {
    const result = await this.#db
      .prepare(INSERT_EVENT_WITH_GUARDS_SQL)
      .bind(...bindInsertEventWithGuards(input))
      .run();

    if (result.meta.changes === 1) {
      return { status: "created" };
    }

    return resolveFailedCreateEventResult(this.#db, input);
  }

  async listEventsForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; after?: EventId; before?: EventId },
  ): Promise<EventListRecord[]> {
    let query = `SELECT
        id,
        endpoint_id,
        received_at,
        method,
        request_path,
        query_json,
        allowlist_headers_json,
        body_size,
        body_sha256,
        body_r2_key,
        request_r2_key
      FROM events
      WHERE endpoint_id = ?`;
    const bindings: (string | number)[] = [endpointId];

    if (options.after !== undefined) {
      query += ` AND sequence > (
        SELECT sequence FROM events WHERE endpoint_id = ? AND id = ?
      )
      ORDER BY sequence ASC LIMIT ?`;
      bindings.push(endpointId, options.after, options.limit);
    } else {
      if (options.before !== undefined) {
        query += ` AND sequence < (
          SELECT sequence FROM events WHERE endpoint_id = ? AND id = ?
        )`;
        bindings.push(endpointId, options.before);
      }

      query += " ORDER BY sequence DESC LIMIT ?";
      bindings.push(options.limit);
    }

    const result = await this.#db
      .prepare(query)
      .bind(...bindings)
      .all<EventListRow>();

    return result.results.map(eventListRowToRecord);
  }

  async findEvent(id: EventId): Promise<EventMetadataInsert | null> {
    const row = await this.#db
      .prepare("SELECT * FROM events WHERE id = ?")
      .bind(id)
      .first<EventRow>();

    return row === null ? null : eventRowToMetadataInsert(row);
  }

  async listEventObjectKeysForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; afterSequence?: number },
  ): Promise<{ sequence: number; bodyR2Key: string; requestR2Key: string }[]> {
    const bindings: (string | number)[] = [endpointId];
    let sequenceFilter = "";

    if (options.afterSequence !== undefined) {
      sequenceFilter = "AND sequence > ?";
      bindings.push(options.afterSequence);
    }

    bindings.push(options.limit);

    const result = await this.#db
      .prepare(
        `SELECT sequence, body_r2_key, request_r2_key
         FROM events
         WHERE endpoint_id = ?
         ${sequenceFilter}
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .bind(...bindings)
      .all<{
        sequence: number;
        body_r2_key: string;
        request_r2_key: string;
      }>();

    return result.results.map((row) => ({
      sequence: row.sequence,
      bodyR2Key: row.body_r2_key,
      requestR2Key: row.request_r2_key,
    }));
  }

  async deleteEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    const result = await this.#db
      .prepare("DELETE FROM events WHERE endpoint_id = ?")
      .bind(endpointId)
      .run();

    return result.meta.changes;
  }

  async listExpiredPrivateEventObjectKeys(
    cutoff: Date,
    options: { limit: number; afterSequence?: number },
  ): Promise<
    {
      sequence: number;
      eventId: EventId;
      endpointId: EndpointId;
      bodyR2Key: string;
      requestR2Key: string;
    }[]
  > {
    const bindings: (string | number)[] = [cutoff.toISOString()];
    let sequenceFilter = "";

    if (options.afterSequence !== undefined) {
      sequenceFilter = "AND events.sequence > ?";
      bindings.push(options.afterSequence);
    }

    bindings.push(options.limit);

    const result = await this.#db
      .prepare(
        `SELECT
           events.sequence,
           events.id,
           events.endpoint_id,
           events.body_r2_key,
           events.request_r2_key
         FROM events
         INNER JOIN endpoints ON endpoints.id = events.endpoint_id
         WHERE endpoints.mode = 'private'
           AND events.received_at < ?
           ${sequenceFilter}
         ORDER BY events.sequence ASC
         LIMIT ?`,
      )
      .bind(...bindings)
      .all<{
        sequence: number;
        id: string;
        endpoint_id: string;
        body_r2_key: string;
        request_r2_key: string;
      }>();

    return result.results.map((row) => ({
      sequence: row.sequence,
      eventId: row.id as EventId,
      endpointId: row.endpoint_id as EndpointId,
      bodyR2Key: row.body_r2_key,
      requestR2Key: row.request_r2_key,
    }));
  }

  async deleteEventsByIds(
    eventIds: EventId[],
  ): Promise<{ eventId: EventId; endpointId: EndpointId }[]> {
    if (eventIds.length === 0) {
      return [];
    }

    const placeholders = eventIds.map(() => "?").join(", ");
    const existing = await this.#db
      .prepare(
        `SELECT id, endpoint_id
         FROM events
         WHERE id IN (${placeholders})`,
      )
      .bind(...eventIds)
      .all<{ id: string; endpoint_id: string }>();

    await this.#db
      .prepare(`DELETE FROM events WHERE id IN (${placeholders})`)
      .bind(...eventIds)
      .run();

    return existing.results.map((row) => ({
      eventId: row.id as EventId,
      endpointId: row.endpoint_id as EndpointId,
    }));
  }

  async eventExists(id: EventId): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT id FROM events WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();

    return row !== null;
  }
}
