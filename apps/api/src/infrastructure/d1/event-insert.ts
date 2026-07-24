import type { EndpointId } from "@barestash/shared/ids";
import { classifyFailedCreateEvent } from "../../domain/create-event-guard.js";
import type { EventMetadataInsert } from "../../domain/event.js";
import type { CreateEventResult } from "../../domain/ports.js";

/**
 * Inserts event metadata only when the endpoint is active and ingest-secret
 * guards pass:
 * - no matched secret is allowed only when the endpoint has no active secrets
 * - a matched secret must still be active at insert time
 */
export const INSERT_EVENT_WITH_GUARDS_SQL = `INSERT INTO events (
  id,
  endpoint_id,
  received_at,
  method,
  ingest_path,
  request_path,
  query_json,
  allowlist_headers_json,
  sensitive_header_names_json,
  content_type,
  content_length,
  user_agent,
  body_size,
  body_sha256,
  body_r2_key,
  request_r2_key,
  secret_verification_status,
  matched_secret_id,
  created_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (
  SELECT 1
  FROM endpoints
  WHERE id = ?
    AND status = 'active'
)
AND (
  (
    ? IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM endpoint_secrets
      WHERE endpoint_id = ?
        AND status = 'active'
        AND revoked_at IS NULL
    )
  )
  OR EXISTS (
    SELECT 1
    FROM endpoint_secrets
    WHERE ? IS NOT NULL
      AND id = ?
      AND endpoint_id = ?
      AND status = 'active'
      AND revoked_at IS NULL
  )
)`;

export function bindInsertEventWithGuards(
  input: EventMetadataInsert,
): unknown[] {
  return [
    input.id,
    input.endpoint_id,
    input.received_at,
    input.method,
    input.ingest_path,
    input.request_path,
    input.query_json,
    input.allowlist_headers_json,
    input.sensitive_header_names_json,
    input.content_type,
    input.content_length,
    input.user_agent,
    input.body_size,
    input.body_sha256,
    input.body_r2_key,
    input.request_r2_key,
    input.secret_verification_status,
    input.matched_secret_id,
    input.created_at,
    input.endpoint_id,
    input.matched_secret_id,
    input.endpoint_id,
    input.matched_secret_id,
    input.matched_secret_id,
    input.endpoint_id,
  ];
}

export async function resolveFailedCreateEventResult(
  db: D1Database,
  input: EventMetadataInsert,
): Promise<CreateEventResult> {
  const endpoint = await db
    .prepare("SELECT id FROM endpoints WHERE id = ? AND status = 'active'")
    .bind(input.endpoint_id)
    .first<{ id: EndpointId }>();

  return classifyFailedCreateEvent(endpoint !== null, input.matched_secret_id);
}
