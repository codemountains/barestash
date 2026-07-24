import type { EventDetail, EventMetadata } from "@barestash/shared/events";

import { isBodyMetadata } from "../../domain/body.js";

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function eventContentType(event: EventMetadata | EventDetail): string {
  const headers = "request" in event ? event.request.headers : event.headers;

  return headers["content-type"] ?? "-";
}

export function bodyLines(body: unknown): string[] {
  if (typeof body === "string") {
    return body.split("\n");
  }

  if (isBodyMetadata(body)) {
    return [`${body.content_type} (${formatBytes(body.size)})`];
  }

  return JSON.stringify(body, null, 2).split("\n");
}
