import type { EndpointId } from "@barestash/shared/ids";
import type {
  EndpointSecretRepository,
  EventRepository,
  RequestBodyStore,
} from "../domain/ports.js";

export const PRIVATE_ENDPOINT_DATA_EVENT_KEY_PAGE_SIZE = 25;
export const PRIVATE_ENDPOINT_DATA_R2_DELETE_BATCH_SIZE = 25;

export class RequestBodyObjectDeleteError extends Error {
  constructor() {
    super("Failed to delete request body objects.");
  }
}

export class PrivateEndpointEventReadError extends Error {
  constructor() {
    super("Failed to read endpoint event objects.");
  }
}

export async function deleteRequestBodyObjects(
  requestBodyStore: Pick<RequestBodyStore, "deleteMany">,
  keys: string[],
  batchSize = PRIVATE_ENDPOINT_DATA_R2_DELETE_BATCH_SIZE,
): Promise<number> {
  for (let index = 0; index < keys.length; index += batchSize) {
    try {
      await requestBodyStore.deleteMany(keys.slice(index, index + batchSize));
    } catch {
      throw new RequestBodyObjectDeleteError();
    }
  }

  return keys.length;
}

function objectKeysForEvents(
  events: { bodyR2Key: string; requestR2Key: string }[],
): string[] {
  return events.flatMap((event) => [event.bodyR2Key, event.requestR2Key]);
}

export type DeletePrivateEndpointDataDeps = {
  endpointId: EndpointId;
  eventRepository: Pick<
    EventRepository,
    "listEventObjectKeysForEndpoint" | "deleteEventsForEndpoint"
  >;
  endpointSecretRepository: Pick<
    EndpointSecretRepository,
    "deleteEndpointSecrets"
  >;
  requestBodyStore: Pick<RequestBodyStore, "deleteMany">;
  deleteEndpointRecord: () => Promise<boolean>;
};

export type DeletePrivateEndpointDataResult = {
  deleted_events: number;
  deleted_body_objects: number;
  endpoint_deleted: boolean;
};

export async function deletePrivateEndpointData(
  deps: DeletePrivateEndpointDataDeps,
): Promise<DeletePrivateEndpointDataResult> {
  let deletedBodyObjects = 0;
  let afterSequence: number | undefined;

  while (true) {
    let objectKeys: Awaited<
      ReturnType<EventRepository["listEventObjectKeysForEndpoint"]>
    >;

    try {
      objectKeys = await deps.eventRepository.listEventObjectKeysForEndpoint(
        deps.endpointId,
        {
          limit: PRIVATE_ENDPOINT_DATA_EVENT_KEY_PAGE_SIZE,
          afterSequence,
        },
      );
    } catch {
      throw new PrivateEndpointEventReadError();
    }

    if (objectKeys.length === 0) {
      break;
    }

    deletedBodyObjects += await deleteRequestBodyObjects(
      deps.requestBodyStore,
      objectKeysForEvents(objectKeys),
    );
    afterSequence = objectKeys.at(-1)?.sequence;
  }

  const deletedEvents = await deps.eventRepository.deleteEventsForEndpoint(
    deps.endpointId,
  );
  await deps.endpointSecretRepository.deleteEndpointSecrets(deps.endpointId);
  const endpointDeleted = await deps.deleteEndpointRecord();

  return {
    deleted_events: deletedEvents,
    deleted_body_objects: deletedBodyObjects,
    endpoint_deleted: endpointDeleted,
  };
}
