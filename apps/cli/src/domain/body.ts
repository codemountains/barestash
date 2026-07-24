import type { EventStreamPayload } from "@barestash/shared/events";
import { redactHeadersForDisplay } from "@barestash/shared/headers";

export const syntheticBodyMetadata = Symbol("barestash.syntheticBodyMetadata");

export type BodyMetadata = {
  content_type: string;
  size: number;
  [syntheticBodyMetadata]: true;
};

export function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function isTextContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/x-www-form-urlencoded"
  );
}

export function isMultipartContentType(contentType: string): boolean {
  return (
    contentType.split(";")[0]?.trim().toLowerCase().startsWith("multipart/") ===
    true
  );
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function bodyMetadata(contentType: string, size: number): BodyMetadata {
  return {
    content_type: contentType,
    size,
    [syntheticBodyMetadata]: true,
  };
}

/** @public */
export function isBodyMetadata(body: unknown): body is BodyMetadata {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { [syntheticBodyMetadata]?: unknown })[syntheticBodyMetadata] ===
      true
  );
}

function transformBodyBytes(
  bytes: Uint8Array,
  contentType: string,
  invalidTextFallback: (metadata: BodyMetadata) => unknown,
): unknown {
  const metadata = bodyMetadata(contentType, bytes.byteLength);

  if (bytes.byteLength === 0 || isMultipartContentType(contentType)) {
    return metadata;
  }

  const text = decodeUtf8(bytes);
  const isJson = isJsonContentType(contentType);
  const isText = isTextContentType(contentType);

  if (text === null) {
    return isJson || isText ? invalidTextFallback(metadata) : metadata;
  }

  if (isJson) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  if (isText) {
    return text;
  }

  return metadata;
}

/** @public */
export function transformBody(bytes: Uint8Array, contentType: string): unknown {
  return transformBodyBytes(bytes, contentType, (metadata) => metadata);
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function transformStreamBody(payload: EventStreamPayload): unknown {
  const contentType = payload.request.headers["content-type"] ?? "";
  const bytes = decodeBase64(payload.body.data);

  return transformBodyBytes(bytes, contentType, () => payload.body.data);
}

/** @public */
export function transformStreamPayload(payload: EventStreamPayload): unknown {
  return {
    ...payload,
    request: {
      ...payload.request,
      headers: redactHeadersForDisplay(payload.request.headers),
    },
    body: transformStreamBody(payload),
  };
}
