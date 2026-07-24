import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import {
  formatPatBearerTokenString,
  parseBearerTokenString,
} from "@barestash/shared/bearer-tokens";
import {
  type AccountId,
  type EndpointId,
  type EventId,
  TOKEN_ID_SUFFIX_LENGTH,
  type TokenId,
} from "@barestash/shared/ids";
import { hashCredential } from "../application/credential-hash.js";
import { isEndpointExpired } from "../domain/endpoint.js";
import type { EventListRecord, EventMetadataInsert } from "../domain/event.js";
import type {
  EndpointRepository,
  EventRepository,
  RequestBodyStore,
} from "../domain/ports.js";
import type { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../infrastructure/in-memory/endpoint-repository.js";
import { createTestApiApp } from "./api-app.js";

/** @public */
export function testTokenId(label: string): TokenId {
  const alphanumeric = label.replace(/[^A-Za-z0-9]/g, "");
  const suffix = (alphanumeric + "0".repeat(TOKEN_ID_SUFFIX_LENGTH)).slice(
    0,
    TOKEN_ID_SUFFIX_LENGTH,
  );

  return `tok_${suffix}` as TokenId;
}

function testSecretFromSeed(seed: string): string {
  const alphanumeric = seed.replace(/[^A-Za-z0-9]/g, "");

  return (alphanumeric + "0".repeat(32)).slice(0, 32);
}

/** @public */
export function makeTestTokenSecret(tokenId: TokenId, seed: string): string {
  return formatPatBearerTokenString(tokenId, testSecretFromSeed(seed));
}

/** @public */
export async function seedTestPersonalAccessToken(
  repository: InMemoryAuthDomainRepository,
  tokenId: TokenId,
  seed: string,
): Promise<string> {
  const token = makeTestTokenSecret(tokenId, seed);
  const parsed = parseBearerTokenString(token);
  if (parsed?.type !== "pat") throw new Error("Invalid test PAT.");

  await repository.createAccount({
    id: "acc_test_owner" as AccountId,
    primary_email: "owner@example.com",
    display_name: null,
    avatar_url: null,
    status: "active",
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
  });
  await repository.createPersonalAccessToken({
    id: tokenId,
    account_id: "acc_test_owner",
    name: "test owner",
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

/** @public */
export const fixedNow = new Date("2026-07-05T12:00:00.000Z");

/** @public */
export const makeApp = () =>
  createTestApiApp({
    endpointRepository: new InMemoryEndpointRepository(),
    now: () => fixedNow,
    generateEndpointId: () => "ep_01JDEF",
  });

/** @public */
export class RecordingRequestBodyStore implements RequestBodyStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  readonly deleteManyBatches: string[][] = [];

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.puts.push(key);
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    this.deleteManyBatches.push(keys);

    for (const key of keys) {
      await this.delete(key);
    }
  }

  text(key: string): string {
    const value = this.objects.get(key);

    if (value === undefined) {
      throw new Error(`Missing object: ${key}`);
    }

    return new TextDecoder().decode(value);
  }
}

/** @public */
export class FailingRequestBodyStore implements RequestBodyStore {
  async put(): Promise<void> {
    throw new Error("storage unavailable");
  }

  async get(): Promise<Uint8Array | null> {
    throw new Error("storage unavailable");
  }

  async delete(): Promise<void> {
    throw new Error("storage unavailable");
  }

  async deleteMany(): Promise<void> {
    throw new Error("storage unavailable");
  }
}

/** @public */
export class BlockingCatchUpBodyStore extends RecordingRequestBodyStore {
  blockCatchUpBodyReads = false;
  #resolveReadStarted: (() => void) | null = null;
  #resolveRelease: (() => void) | null = null;

  readonly catchUpBodyReadStarted = new Promise<void>((resolve) => {
    this.#resolveReadStarted = resolve;
  });

  async get(key: string): Promise<Uint8Array | null> {
    if (this.blockCatchUpBodyReads && key.endsWith("/evt_catchup/body.raw")) {
      this.#resolveReadStarted?.();
      await new Promise<void>((resolve) => {
        this.#resolveRelease = resolve;
      });
    }

    return super.get(key);
  }

  releaseCatchUpBodyRead(): void {
    this.#resolveRelease?.();
  }
}

/** @public */
export class RecordingEventRepository implements EventRepository {
  readonly events: EventMetadataInsert[] = [];
  eventCount = 0;

  async countEventsForEndpoint(): Promise<number> {
    return this.eventCount;
  }

  async createEvent(
    input: EventMetadataInsert,
  ): Promise<import("../domain/ports.js").CreateEventResult> {
    this.events.push(input);
    this.eventCount += 1;

    return { status: "created" };
  }

  async listEventsForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; after?: EventId; before?: EventId },
  ): Promise<EventListRecord[]> {
    const events = this.events.filter(
      (event) => event.endpoint_id === endpointId,
    );

    if (options.after !== undefined) {
      const cursorIndex = events.findIndex(
        (event) => event.id === options.after,
      );

      return cursorIndex === -1
        ? []
        : events.slice(cursorIndex + 1, cursorIndex + 1 + options.limit);
    }

    let candidates = events;

    if (options.before !== undefined) {
      const cursorIndex = events.findIndex(
        (event) => event.id === options.before,
      );
      candidates = cursorIndex === -1 ? [] : events.slice(0, cursorIndex);
    }

    return [...candidates].reverse().slice(0, options.limit);
  }

  async findEvent(id: EventId): Promise<EventMetadataInsert | null> {
    return this.events.find((event) => event.id === id) ?? null;
  }

  async listEventObjectKeysForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; afterSequence?: number },
  ): Promise<{ sequence: number; bodyR2Key: string; requestR2Key: string }[]> {
    return this.events
      .map((event, index) => ({ event, sequence: index + 1 }))
      .filter(
        ({ event, sequence }) =>
          event.endpoint_id === endpointId &&
          sequence > (options.afterSequence ?? 0),
      )
      .slice(0, options.limit)
      .map(({ event, sequence }) => ({
        sequence,
        bodyR2Key: event.body_r2_key,
        requestR2Key: event.request_r2_key,
      }));
  }

  async deleteEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    const before = this.events.length;
    const remaining = this.events.filter(
      (event) => event.endpoint_id !== endpointId,
    );
    this.events.length = 0;
    this.events.push(...remaining);

    return before - remaining.length;
  }
}

/** @public */
export const makeTemporaryEndpointRepository = (
  overrides: Partial<
    Awaited<ReturnType<EndpointRepository["findEndpoint"]>>
  > = {},
) => {
  const endpoint = {
    id: "ep_01JDEF" as EndpointId,
    name: null,
    mode: "temporary" as const,
    status: "active" as const,
    public_read: true,
    event_count: 0,
    event_limit: 100,
    expires_at: "2026-07-06T12:00:00.000Z",
    created_at: "2026-07-05T12:00:00.000Z",
    updated_at: "2026-07-05T12:00:00.000Z",
    ...overrides,
  };

  return {
    async createTemporaryEndpoint() {
      throw new Error("not used");
    },
    async listActiveTemporaryEndpoints() {
      return [];
    },
    async listPrivateEndpoints() {
      return [];
    },
    async findEndpoint(id: EndpointId) {
      return {
        ...endpoint,
        id,
      };
    },
    async reserveTemporaryEventSlot(_id: EndpointId, limit: number) {
      if (endpoint.event_count >= limit) {
        return false;
      }

      endpoint.event_count += 1;

      return true;
    },
    async releaseTemporaryEventSlot() {
      endpoint.event_count = Math.max(endpoint.event_count - 1, 0);
    },
    async incrementPrivateEndpointEventCount() {
      if (endpoint.mode !== "private" || endpoint.status !== "active") {
        return false;
      }

      endpoint.event_count += 1;

      return true;
    },
    async reservePrivateEventSlot(_id: EndpointId, limit: number, now: Date) {
      if (
        endpoint.mode !== "private" ||
        endpoint.status !== "active" ||
        endpoint.event_count >= limit
      ) {
        return false;
      }

      if (isEndpointExpired(endpoint, now)) {
        return false;
      }

      endpoint.event_count += 1;

      return true;
    },
    async releasePrivateEndpointEventCount() {
      if (endpoint.mode === "private") {
        endpoint.event_count = Math.max(endpoint.event_count - 1, 0);
      }
    },
    async disableEndpoint() {
      if (endpoint.mode !== "private" || endpoint.status !== "active") {
        return false;
      }

      endpoint.status = "disabled";
      return true;
    },
    async deleteEndpoint() {},
  } satisfies EndpointRepository;
};

/** @public */
export const hashCredentialForTest = async (secret: string): Promise<string> =>
  hashCredential(secret, { pepper: "" });

/** @public */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** @public */
export const readStreamTextUntil = async (
  response: Response,
  includes: string,
): Promise<string> => {
  if (response.body === null) {
    throw new Error("Expected stream response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (!text.includes(includes)) {
      const { done, value } = await reader.read();

      if (done) {
        throw new Error(`Stream ended before ${includes}. Received: ${text}`);
      }

      text += decoder.decode(value, { stream: true });
    }

    return text;
  } finally {
    await reader.cancel();
  }
};

/** @public */
export const parseFirstSsePayload = (
  streamText: string,
): import("@barestash/shared/events").EventStreamPayload => {
  const dataLine = streamText
    .split("\n")
    .find((line) => line.startsWith("data: "));

  if (dataLine === undefined) {
    throw new Error(`Missing SSE data line: ${streamText}`);
  }

  return JSON.parse(
    dataLine.slice("data: ".length),
  ) as import("@barestash/shared/events").EventStreamPayload;
};

/** @public */
export const unusedEndpointEventSlots = {
  async reserveTemporaryEventSlot() {
    throw new Error("not used");
  },
  async releaseTemporaryEventSlot() {},
  async incrementPrivateEndpointEventCount() {
    throw new Error("not used");
  },
  async reservePrivateEventSlot() {
    throw new Error("not used");
  },
  async releasePrivateEndpointEventCount() {},
  async disableEndpoint() {
    throw new Error("not used");
  },
  async deleteEndpoint() {},
} satisfies Pick<
  EndpointRepository,
  | "reserveTemporaryEventSlot"
  | "releaseTemporaryEventSlot"
  | "incrementPrivateEndpointEventCount"
  | "reservePrivateEventSlot"
  | "releasePrivateEndpointEventCount"
  | "disableEndpoint"
  | "deleteEndpoint"
>;
