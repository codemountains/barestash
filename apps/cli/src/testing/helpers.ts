import type { EventDetail, EventStreamPayload } from "@barestash/shared/events";
import { REDACTED_HEADER_VALUE } from "@barestash/shared/headers";
import { TOKEN_ID_SUFFIX_LENGTH, type TokenId } from "@barestash/shared/ids";

/** @public */
export function testTokenId(label: string): TokenId {
  const alphanumeric = label.replace(/[^A-Za-z0-9]/g, "");
  const suffix = (alphanumeric + "0".repeat(TOKEN_ID_SUFFIX_LENGTH)).slice(
    0,
    TOKEN_ID_SUFFIX_LENGTH,
  );

  return `tok_${suffix}` as TokenId;
}

/** @public */
export const makeIo = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
};

/** @public */
export const sseResponse = (payloads: EventStreamPayload[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(
          encoder.encode(
            `id: ${payload.id}\nevent: event\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      }

      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
};

/** @public */
export const streamPayload = (
  overrides: Partial<EventStreamPayload>,
): EventStreamPayload => ({
  id: "evt_01JDEF",
  endpoint_id: "ep_01JDEF",
  received_at: "2026-07-05T12:04:32.000Z",
  request: {
    method: "POST",
    path: "/webhook/stripe",
    query: {},
    headers: {
      "content-type": "application/json",
    },
    body_size: 11,
    body_sha256: "hash",
  },
  body: {
    encoding: "base64",
    data: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
  },
  ...overrides,
});

/** @public */
export const eventMetadata = {
  id: "evt_01JDEF",
  endpoint_id: "ep_01JDEF",
  received_at: "2026-07-05T12:04:32.000Z",
  method: "POST",
  request_path: "/webhook/stripe",
  query: {},
  headers: {
    "content-type": "application/json",
  },
  body: {
    size: 17,
    sha256: "hash",
    available: true,
  },
};

/** @public */
export const eventDetail: EventDetail = {
  id: "evt_01JDEF",
  endpoint_id: "ep_01JDEF",
  received_at: "2026-07-05T12:04:32.000Z",
  request: {
    method: "POST",
    ingest_path: "/ep_01JDEF/webhook/stripe",
    request_path: "/webhook/stripe",
    query: {},
    headers: {
      "content-type": "application/json",
      "stripe-signature": REDACTED_HEADER_VALUE,
    },
    body: {
      size: 17,
      sha256: "hash",
      available: true,
      url: "/v1/events/evt_01JDEF/body",
    },
  },
};

/** @public */
export const rawSensitiveEventDetail: EventDetail = {
  ...eventDetail,
  request: {
    ...eventDetail.request,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer raw-token",
      "stripe-signature": "t=raw,v1=raw",
      "x-barestash-secret": "endpoint-secret",
    },
  },
};
