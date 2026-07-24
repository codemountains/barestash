import type { EndpointId, EventId } from "@barestash/shared/ids";

import { evaluateCreateEventGuard } from "../../domain/create-event-guard.js";
import type {
  EventListRecord,
  EventMetadataInsert,
} from "../../domain/event.js";
import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
} from "../../domain/ports.js";

/** @public */
export class InMemoryEventRepository implements EventRepository {
  readonly #events = new Map<EndpointId, EventMetadataInsert[]>();
  readonly #endpointRepository?: EndpointRepository;
  readonly #endpointSecretRepository?: EndpointSecretRepository;

  constructor(
    options: {
      endpointRepository?: EndpointRepository;
      endpointSecretRepository?: EndpointSecretRepository;
    } = {},
  ) {
    this.#endpointRepository = options.endpointRepository;
    this.#endpointSecretRepository = options.endpointSecretRepository;
  }

  async countEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    return this.#events.get(endpointId)?.length ?? 0;
  }

  async createEvent(
    input: EventMetadataInsert,
  ): Promise<import("../../domain/ports.js").CreateEventResult> {
    if (
      this.#endpointRepository !== undefined &&
      this.#endpointSecretRepository !== undefined
    ) {
      const endpoint = await this.#endpointRepository.findEndpoint(
        input.endpoint_id,
      );
      const activeSecrets =
        await this.#endpointSecretRepository.listActiveEndpointSecrets(
          input.endpoint_id,
        );
      const guard = evaluateCreateEventGuard(input, endpoint, activeSecrets);

      if (guard !== "allowed") {
        return guard;
      }
    }

    const events = this.#events.get(input.endpoint_id) ?? [];
    events.push(input);
    this.#events.set(input.endpoint_id, events);

    return { status: "created" };
  }

  async listEventsForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; after?: EventId; before?: EventId },
  ): Promise<EventListRecord[]> {
    const events = [...(this.#events.get(endpointId) ?? [])];

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
    for (const events of this.#events.values()) {
      const event = events.find((candidate) => candidate.id === id);

      if (event !== undefined) {
        return event;
      }
    }

    return null;
  }

  async listEventObjectKeysForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; afterSequence?: number },
  ): Promise<{ sequence: number; bodyR2Key: string; requestR2Key: string }[]> {
    return (this.#events.get(endpointId) ?? [])
      .map((event, index) => ({ event, sequence: index + 1 }))
      .filter(({ sequence }) => sequence > (options.afterSequence ?? 0))
      .slice(0, options.limit)
      .map(({ event, sequence }) => ({
        sequence,
        bodyR2Key: event.body_r2_key,
        requestR2Key: event.request_r2_key,
      }));
  }

  async deleteEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    const deleted = this.#events.get(endpointId)?.length ?? 0;
    this.#events.delete(endpointId);

    return deleted;
  }
}
