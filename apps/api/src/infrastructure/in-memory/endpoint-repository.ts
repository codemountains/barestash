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
  isEndpointExpired,
  type StoredEndpoint,
} from "../../domain/endpoint.js";
import type { EndpointRepository } from "../../domain/ports.js";

/** @public */
export class InMemoryEndpointRepository implements EndpointRepository {
  readonly #endpoints = new Map<EndpointId, StoredEndpoint>();

  async createTemporaryEndpoint(
    input: CreateTemporaryEndpointInput,
  ): Promise<StoredEndpoint> {
    const createdAt = input.now.toISOString();
    const endpoint = {
      id: input.id,
      name: input.name,
      mode: "temporary",
      status: "active",
      public_read: true,
      event_count: 0,
      event_limit: TEMPORARY_ENDPOINT_EVENT_LIMIT,
      expires_at: new Date(
        input.now.getTime() + TEMPORARY_ENDPOINT_TTL_SECONDS * 1000,
      ).toISOString(),
      created_at: createdAt,
      updated_at: createdAt,
    } satisfies StoredEndpoint;

    this.#endpoints.set(endpoint.id, endpoint);

    return endpoint;
  }

  async createPrivateEndpoint(
    input: CreatePrivateEndpointInput,
  ): Promise<StoredEndpoint> {
    const createdAt = input.now.toISOString();
    const expiresAt = new Date(
      input.now.getTime() + PRIVATE_ENDPOINT_TTL_SECONDS * 1000,
    ).toISOString();
    const endpoint = {
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
    } satisfies StoredEndpoint;

    this.#endpoints.set(endpoint.id, endpoint);

    return endpoint;
  }

  async listActiveTemporaryEndpoints(now: Date): Promise<StoredEndpoint[]> {
    return Array.from(this.#endpoints.values()).filter(
      (endpoint) =>
        endpoint.mode === "temporary" &&
        endpoint.status === "active" &&
        !isEndpointExpired(endpoint, now),
    );
  }

  async listPrivateEndpoints(
    accountId: AccountId,
    now: Date,
  ): Promise<StoredEndpoint[]> {
    return Array.from(this.#endpoints.values()).filter(
      (endpoint) =>
        endpoint.mode === "private" &&
        endpoint.status === "active" &&
        endpoint.account_id === accountId &&
        !isEndpointExpired(endpoint, now),
    );
  }

  async findEndpoint(id: EndpointId): Promise<StoredEndpoint | null> {
    return this.#endpoints.get(id) ?? null;
  }

  async reserveTemporaryEventSlot(
    id: EndpointId,
    limit: number,
  ): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (endpoint === undefined || endpoint.event_count >= limit) {
      return false;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      event_count: endpoint.event_count + 1,
    });

    return true;
  }

  async releaseTemporaryEventSlot(id: EndpointId): Promise<void> {
    const endpoint = this.#endpoints.get(id);

    if (endpoint === undefined) {
      return;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      event_count: Math.max(endpoint.event_count - 1, 0),
    });
  }

  async incrementPrivateEndpointEventCount(id: EndpointId): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (
      endpoint === undefined ||
      endpoint.mode !== "private" ||
      endpoint.status !== "active"
    ) {
      return false;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      event_count: endpoint.event_count + 1,
    });

    return true;
  }

  async reservePrivateEventSlot(
    id: EndpointId,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (
      endpoint === undefined ||
      endpoint.mode !== "private" ||
      endpoint.status !== "active" ||
      endpoint.event_count >= limit ||
      isEndpointExpired(endpoint, now)
    ) {
      return false;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      event_count: endpoint.event_count + 1,
    });

    return true;
  }

  async releasePrivateEndpointEventCount(id: EndpointId): Promise<void> {
    const endpoint = this.#endpoints.get(id);

    if (endpoint === undefined || endpoint.mode !== "private") {
      return;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      event_count: Math.max(endpoint.event_count - 1, 0),
    });
  }

  async disableEndpoint(
    id: EndpointId,
    accountId: AccountId,
    updatedAt: string,
  ): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (
      endpoint === undefined ||
      endpoint.mode !== "private" ||
      endpoint.account_id !== accountId ||
      endpoint.status !== "active"
    ) {
      return false;
    }

    this.#endpoints.set(id, {
      ...endpoint,
      status: "disabled",
      updated_at: updatedAt,
    });

    return true;
  }

  async deleteEndpoint(id: EndpointId, accountId: AccountId): Promise<void> {
    const endpoint = this.#endpoints.get(id);

    if (
      endpoint === undefined ||
      endpoint.mode !== "private" ||
      endpoint.account_id !== accountId
    ) {
      return;
    }

    this.#endpoints.delete(id);
  }

  async listExpiredTemporaryEndpoints(
    now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    return Array.from(this.#endpoints.values())
      .filter(
        (endpoint) =>
          endpoint.mode === "temporary" &&
          (endpoint.status === "expired" ||
            endpoint.expires_at <= now.toISOString()),
      )
      .sort((left, right) =>
        left.expires_at === right.expires_at
          ? left.created_at.localeCompare(right.created_at)
          : left.expires_at.localeCompare(right.expires_at),
      )
      .slice(0, options.limit);
  }

  async deleteTemporaryEndpoint(id: EndpointId): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (endpoint === undefined || endpoint.mode !== "temporary") {
      return false;
    }

    this.#endpoints.delete(id);

    return true;
  }

  async listExpiredPrivateEndpoints(
    now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    return Array.from(this.#endpoints.values())
      .filter(
        (endpoint) =>
          endpoint.mode === "private" &&
          (endpoint.status === "expired" ||
            endpoint.expires_at <= now.toISOString()),
      )
      .sort((left, right) =>
        left.expires_at === right.expires_at
          ? left.created_at.localeCompare(right.created_at)
          : left.expires_at.localeCompare(right.expires_at),
      )
      .slice(0, options.limit);
  }

  async deletePrivateEndpoint(id: EndpointId): Promise<boolean> {
    const endpoint = this.#endpoints.get(id);

    if (endpoint === undefined || endpoint.mode !== "private") {
      return false;
    }

    this.#endpoints.delete(id);

    return true;
  }

  async reconcilePrivateEndpointEventCounts(): Promise<void> {
    // In-memory event counts are updated eagerly during ingest.
  }
}
