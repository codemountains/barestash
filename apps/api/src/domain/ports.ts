import type { EventStreamPayload } from "@barestash/shared/events";
import type { EndpointId, EventId } from "@barestash/shared/ids";

import type {
  AccountId,
  CreatePrivateEndpointInput,
  CreateTemporaryEndpointInput,
  StoredEndpoint,
} from "./endpoint.js";
import type {
  CreateEndpointSecretInput,
  StoredEndpointSecret,
} from "./endpoint-secret.js";
import type { EventListRecord, EventMetadataInsert } from "./event.js";

/** @public */
export type EndpointRepository = {
  createTemporaryEndpoint: (
    input: CreateTemporaryEndpointInput,
  ) => Promise<StoredEndpoint>;
  createPrivateEndpoint?: (
    input: CreatePrivateEndpointInput,
  ) => Promise<StoredEndpoint>;
  listActiveTemporaryEndpoints: (now: Date) => Promise<StoredEndpoint[]>;
  listPrivateEndpoints?: (
    accountId: AccountId,
    now: Date,
  ) => Promise<StoredEndpoint[]>;
  findEndpoint: (
    id: import("@barestash/shared/ids").EndpointId,
  ) => Promise<StoredEndpoint | null>;
  reserveTemporaryEventSlot: (
    id: import("@barestash/shared/ids").EndpointId,
    limit: number,
  ) => Promise<boolean>;
  releaseTemporaryEventSlot: (
    id: import("@barestash/shared/ids").EndpointId,
  ) => Promise<void>;
  incrementPrivateEndpointEventCount: (
    id: import("@barestash/shared/ids").EndpointId,
  ) => Promise<boolean>;
  reservePrivateEventSlot: (
    id: import("@barestash/shared/ids").EndpointId,
    limit: number,
    now: Date,
  ) => Promise<boolean>;
  releasePrivateEndpointEventCount: (
    id: import("@barestash/shared/ids").EndpointId,
  ) => Promise<void>;
  disableEndpoint: (
    id: import("@barestash/shared/ids").EndpointId,
    accountId: AccountId,
    updatedAt: string,
  ) => Promise<boolean>;
  deleteEndpoint: (
    id: import("@barestash/shared/ids").EndpointId,
    accountId: AccountId,
  ) => Promise<void>;
};

/** @public */
export type EndpointSecretRepository = {
  createEndpointSecret: (
    input: CreateEndpointSecretInput,
  ) => Promise<StoredEndpointSecret>;
  listEndpointSecrets: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<StoredEndpointSecret[]>;
  listActiveEndpointSecrets: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<StoredEndpointSecret[]>;
  updateEndpointSecretLastUsed: (
    id: import("@barestash/shared/ids").SecretId,
    lastUsedAt: string,
  ) => Promise<void>;
  revokeEndpointSecret: (
    endpointId: import("@barestash/shared/ids").EndpointId,
    id: import("@barestash/shared/ids").SecretId,
    revokedAt: string,
  ) => Promise<StoredEndpointSecret | null>;
  deleteEndpointSecrets: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<void>;
};

/** @public */
export type EventRepository = {
  countEventsForEndpoint: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<number>;
  createEvent: (input: EventMetadataInsert) => Promise<CreateEventResult>;
  listEventsForEndpoint: (
    endpointId: import("@barestash/shared/ids").EndpointId,
    options: { limit: number; after?: EventId; before?: EventId },
  ) => Promise<EventListRecord[]>;
  findEvent: (id: EventId) => Promise<EventMetadataInsert | null>;
  listEventObjectKeysForEndpoint: (
    endpointId: import("@barestash/shared/ids").EndpointId,
    options: { limit: number; afterSequence?: number },
  ) => Promise<{ sequence: number; bodyR2Key: string; requestR2Key: string }[]>;
  deleteEventsForEndpoint: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<number>;
};

/** @public */
export type CleanupEndpointRepository = {
  listExpiredTemporaryEndpoints: (
    now: Date,
    options: { limit: number },
  ) => Promise<StoredEndpoint[]>;
  deleteTemporaryEndpoint: (id: EndpointId) => Promise<boolean>;
  listExpiredPrivateEndpoints: (
    now: Date,
    options: { limit: number },
  ) => Promise<StoredEndpoint[]>;
  deletePrivateEndpoint: (id: EndpointId) => Promise<boolean>;
  reconcilePrivateEndpointEventCounts: () => Promise<void>;
};

/** @public */
export type CleanupEndpointSecretRepository = Pick<
  EndpointSecretRepository,
  "deleteEndpointSecrets"
>;

/** @public */
export type CleanupEventObjectKeys = {
  sequence: number;
  eventId: EventId;
  endpointId: EndpointId;
  bodyR2Key: string;
  requestR2Key: string;
};

/** @public */
export type CleanupEventRepository = {
  listEventObjectKeysForEndpoint: EventRepository["listEventObjectKeysForEndpoint"];
  deleteEventsForEndpoint: EventRepository["deleteEventsForEndpoint"];
  listExpiredPrivateEventObjectKeys: (
    cutoff: Date,
    options: { limit: number; afterSequence?: number },
  ) => Promise<CleanupEventObjectKeys[]>;
  deleteEventsByIds: (
    eventIds: EventId[],
  ) => Promise<{ eventId: EventId; endpointId: EndpointId }[]>;
  eventExists: (id: EventId) => Promise<boolean>;
};

/** @public */
export type CreateEventResult =
  | { status: "created" }
  | { status: "endpoint_inactive" }
  | { status: "matched_secret_inactive" }
  | { status: "active_secret_required" };

/** @public */
export type RequestBodyStore = {
  put: (key: string, value: Uint8Array | string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  delete: (key: string) => Promise<void>;
  deleteMany: (keys: string[]) => Promise<void>;
};

export type RequestBodyObject = {
  key: string;
  uploaded: Date;
};

/** @public */
export type RequestBodyObjectList =
  | {
      objects: RequestBodyObject[];
      truncated: true;
      cursor: string;
    }
  | {
      objects: RequestBodyObject[];
      truncated: false;
    };

/** @public */
export type CleanupRequestBodyStore = RequestBodyStore & {
  listObjects: (options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }) => Promise<RequestBodyObjectList>;
};

/** @public */
export type EventStreamSubscription = {
  stream: ReadableStream<Uint8Array>;
  send: (payload: EventStreamPayload) => void;
  flushBuffered: () => void;
  cancel: () => Promise<void> | void;
};

/** @public */
export type EventStreamSubscriberPresence = {
  hasSubscribers: boolean;
  maxSubscriberSequence: number;
};

/** @public */
export type EventStreamCoordinator = {
  subscribe: (
    endpointId: import("@barestash/shared/ids").EndpointId,
    options?: {
      bufferPublishedEvents?: boolean;
      maxDurationMilliseconds?: number;
    },
  ) => Promise<EventStreamSubscription>;
  getSubscriberPresence: (
    endpointId: import("@barestash/shared/ids").EndpointId,
  ) => Promise<EventStreamSubscriberPresence>;
  publish: (
    endpointId: import("@barestash/shared/ids").EndpointId,
    payload: EventStreamPayload,
    options?: {
      maxSubscriberSequence?: number;
    },
  ) => Promise<void>;
};
