import type { EventStreamPayload } from "@barestash/shared/events";
import type { EndpointId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";

import { InMemoryEventStreamCoordinator } from "./event-stream-coordinator.js";

const endpointId = "ep_in_memory" as EndpointId;
const payload: EventStreamPayload = {
  id: "evt_in_memory" as EventStreamPayload["id"],
  endpoint_id: endpointId,
  received_at: "2026-07-05T12:04:32.000Z",
  request: {
    method: "POST",
    path: "/webhook",
    query: {},
    headers: {},
    body_size: 2,
    body_sha256: "sha256",
  },
  body: { encoding: "base64", data: "e30=" },
};

describe("InMemoryEventStreamCoordinator", () => {
  it("reports subscriber presence across join and leave boundaries", async () => {
    const coordinator = new InMemoryEventStreamCoordinator();

    await expect(
      coordinator.getSubscriberPresence(endpointId),
    ).resolves.toEqual({
      hasSubscribers: false,
      maxSubscriberSequence: 0,
    });

    const subscription = await coordinator.subscribe(endpointId);
    await expect(
      coordinator.getSubscriberPresence(endpointId),
    ).resolves.toEqual({
      hasSubscribers: true,
      maxSubscriberSequence: 1,
    });

    await subscription.cancel();
    await expect(
      coordinator.getSubscriberPresence(endpointId),
    ).resolves.toEqual({
      hasSubscribers: false,
      maxSubscriberSequence: 1,
    });
  });

  it("does not publish a pre-probe event to a subscriber that joins after the probe", async () => {
    const coordinator = new InMemoryEventStreamCoordinator();
    const firstSubscription = await coordinator.subscribe(endpointId);
    const presence = await coordinator.getSubscriberPresence(endpointId);

    await firstSubscription.cancel();
    const secondSubscription = await coordinator.subscribe(endpointId);
    const reader = secondSubscription.stream.getReader();
    const read = reader.read();

    await coordinator.publish(endpointId, payload, {
      maxSubscriberSequence: presence.maxSubscriberSequence,
    });
    await reader.cancel();

    await expect(read).resolves.toMatchObject({ done: true });
  });
});
