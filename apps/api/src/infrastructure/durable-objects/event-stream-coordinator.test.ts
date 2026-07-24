import type { EventStreamPayload } from "@barestash/shared/events";
import { sseMessage } from "@barestash/shared/sse";
import { describe, expect, it, vi } from "vitest";
import { EndpointStream } from "../../worker.js";
import { DurableObjectEventStreamCoordinator } from "./event-stream-coordinator.js";

const payload = (id = "evt_do_1"): EventStreamPayload => ({
  id: id as EventStreamPayload["id"],
  endpoint_id: "ep_do" as EventStreamPayload["endpoint_id"],
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
});

const readText = async (
  stream: ReadableStream<Uint8Array>,
  includes: string,
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes(includes)) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error(`Stream ended before ${includes}. Received: ${text}`);
    }

    text += decoder.decode(value);
  }

  await reader.cancel();
  return text;
};

describe("EndpointStream", () => {
  it("reports subscriber presence across join and leave boundaries", async () => {
    const object = new EndpointStream();

    const beforeJoin = await object.fetch(
      new Request("https://barestash.internal/subscribers"),
    );
    await expect(beforeJoin.json()).resolves.toEqual({
      hasSubscribers: false,
      maxSubscriberSequence: 0,
    });

    const subscription = await object.fetch(
      new Request("https://barestash.internal/subscribe"),
    );
    const afterJoin = await object.fetch(
      new Request("https://barestash.internal/subscribers"),
    );
    await expect(afterJoin.json()).resolves.toEqual({
      hasSubscribers: true,
      maxSubscriberSequence: 1,
    });

    await subscription.body?.cancel();
    const afterLeave = await object.fetch(
      new Request("https://barestash.internal/subscribers"),
    );
    await expect(afterLeave.json()).resolves.toEqual({
      hasSubscribers: false,
      maxSubscriberSequence: 1,
    });
  });

  it("does not publish a pre-probe event to a subscriber that joins after the probe", async () => {
    const object = new EndpointStream();
    const firstSubscription = await object.fetch(
      new Request("https://barestash.internal/subscribe"),
    );
    const presence = (await (
      await object.fetch(new Request("https://barestash.internal/subscribers"))
    ).json()) as {
      maxSubscriberSequence: number;
    };

    await firstSubscription.body?.cancel();
    const secondSubscription = await object.fetch(
      new Request("https://barestash.internal/subscribe"),
    );
    if (secondSubscription.body === null) {
      throw new Error("subscription response did not include a body");
    }
    const reader = secondSubscription.body.getReader();
    const read = reader.read();

    await object.fetch(
      new Request(
        `https://barestash.internal/publish?maxSubscriberSequence=${presence.maxSubscriberSequence}`,
        {
          method: "POST",
          body: JSON.stringify(payload()),
        },
      ),
    );
    await reader.cancel();

    await expect(read).resolves.toMatchObject({ done: true });
  });

  it("subscribes clients, publishes SSE messages, and removes cancelled subscribers", async () => {
    const object = new EndpointStream();
    const subscription = await object.fetch(
      new Request("https://barestash.internal/subscribe"),
    );

    expect(subscription.status).toBe(200);
    expect(subscription.headers.get("content-type")).toBe("text/event-stream");

    if (subscription.body === null) {
      throw new Error("subscription response did not include a body");
    }

    const textPromise = readText(subscription.body, "evt_do_1");
    const publish = await object.fetch(
      new Request("https://barestash.internal/publish", {
        method: "POST",
        body: JSON.stringify(payload()),
      }),
    );

    expect(publish.status).toBe(204);
    await expect(textPromise).resolves.toContain("data: ");
  });

  it("deduplicates published events by event id", async () => {
    const object = new EndpointStream();
    const subscription = await object.fetch(
      new Request("https://barestash.internal/subscribe"),
    );

    if (subscription.body === null) {
      throw new Error("subscription response did not include a body");
    }

    const reader = subscription.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    await object.fetch(
      new Request("https://barestash.internal/publish", {
        method: "POST",
        body: JSON.stringify(payload()),
      }),
    );
    await object.fetch(
      new Request("https://barestash.internal/publish", {
        method: "POST",
        body: JSON.stringify(payload()),
      }),
    );

    const first = await reader.read();
    if (first.done || first.value === undefined) {
      throw new Error("Expected first SSE chunk");
    }

    text += decoder.decode(first.value);
    await reader.cancel();

    expect(text.match(/event: event/g)?.length ?? 0).toBe(1);
  });

  it("returns 404 for unsupported Durable Object routes", async () => {
    const object = new EndpointStream();

    const response = await object.fetch(
      new Request("https://barestash.internal/unknown"),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });
});

describe("DurableObjectEventStreamCoordinator", () => {
  it("queries subscriber presence from the endpoint stream Durable Object", async () => {
    const calls: Request[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          calls.push(request);
          return Response.json({
            hasSubscribers: true,
            maxSubscriberSequence: 3,
          });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const coordinator = new DurableObjectEventStreamCoordinator(namespace);

    await expect(
      coordinator.getSubscriberPresence(
        "ep_do" as EventStreamPayload["endpoint_id"],
      ),
    ).resolves.toEqual({
      hasSubscribers: true,
      maxSubscriberSequence: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://barestash.internal/subscribers");
  });

  it("publishes payloads to the endpoint stream Durable Object", async () => {
    const calls: Request[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          calls.push(request);
          return new Response(null, { status: 204 });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const coordinator = new DurableObjectEventStreamCoordinator(namespace);

    await coordinator.publish(
      "ep_do" as EventStreamPayload["endpoint_id"],
      payload(),
      { maxSubscriberSequence: 3 },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://barestash.internal/publish?maxSubscriberSequence=3",
    );
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    await expect(calls[0].json()).resolves.toEqual(payload());
  });

  it("rejects subscriptions when the Durable Object does not return a stream", async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(null, { status: 500 }),
      }),
    } as unknown as DurableObjectNamespace;
    const coordinator = new DurableObjectEventStreamCoordinator(namespace);

    await expect(
      coordinator.subscribe("ep_do" as EventStreamPayload["endpoint_id"]),
    ).rejects.toThrow(
      "Endpoint stream Durable Object did not return a stream.",
    );
  });

  it("splits CRLF framed SSE messages from the Durable Object stream", async () => {
    const crlfMessage = sseMessage(payload("evt_crlf")).replaceAll(
      "\n",
      "\r\n",
    );
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(crlfMessage));
                controller.close();
              },
            }),
          ),
      }),
    } as unknown as DurableObjectNamespace;
    const coordinator = new DurableObjectEventStreamCoordinator(namespace);
    const subscription = await coordinator.subscribe(
      "ep_do" as EventStreamPayload["endpoint_id"],
    );
    const reader = subscription.stream.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();

    expect(decoder.decode(value)).toContain("evt_crlf");
    await reader.cancel();
    await subscription.cancel();
  });

  it("closes subscriptions when their configured lifetime expires", async () => {
    vi.useFakeTimers();

    try {
      let cancelled = false;
      const namespace = {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
      } as unknown as DurableObjectNamespace;
      const coordinator = new DurableObjectEventStreamCoordinator(namespace);
      const subscription = await coordinator.subscribe(
        "ep_do" as EventStreamPayload["endpoint_id"],
        { maxDurationMilliseconds: 60 * 60 * 1000 },
      );
      const reader = subscription.stream.getReader();
      let streamClosed = false;
      void reader.read().then(({ done }) => {
        streamClosed = done;
      });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(streamClosed).toBe(true);
      expect(cancelled).toBe(true);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
