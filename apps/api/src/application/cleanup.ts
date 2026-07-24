import type { EventId } from "@barestash/shared/ids";
import type {
  CleanupEndpointRepository,
  CleanupEndpointSecretRepository,
  CleanupEventObjectKeys,
  CleanupEventRepository,
  CleanupRequestBodyStore,
} from "../domain/ports.js";
import {
  type DeletePrivateEndpointDataResult,
  deletePrivateEndpointData,
  deleteRequestBodyObjects,
  RequestBodyObjectDeleteError,
} from "./delete-private-endpoint-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_EVENT_RETENTION_MS = 7 * DAY_MS;
export const ORPHAN_CLEANUP_MIN_AGE_MS = 60 * 60 * 1000;

const CLEANUP_PAGE_SIZE = 25;
const R2_OBJECT_LIST_LIMIT = 1000;

export type RetentionCleanupSummary = {
  expired_temporary_endpoints_deleted: number;
  temporary_events_deleted: number;
  expired_private_endpoints_deleted: number;
  expired_private_endpoint_events_deleted: number;
  private_events_deleted: number;
  orphan_objects_deleted: number;
  r2_objects_deleted: number;
};

export type RunRetentionCleanupDeps = {
  endpointRepository: CleanupEndpointRepository;
  endpointSecretRepository: CleanupEndpointSecretRepository;
  eventRepository: CleanupEventRepository;
  requestBodyStore: CleanupRequestBodyStore;
  now: Date;
};

/** @public */
export class CleanupR2DeleteError extends RequestBodyObjectDeleteError {}

async function deleteR2Objects(
  requestBodyStore: CleanupRequestBodyStore,
  keys: string[],
): Promise<number> {
  try {
    return await deleteRequestBodyObjects(requestBodyStore, keys);
  } catch (error) {
    if (error instanceof RequestBodyObjectDeleteError) {
      throw new CleanupR2DeleteError();
    }

    throw error;
  }
}

function objectKeysForEvents(
  events: Pick<CleanupEventObjectKeys, "bodyR2Key" | "requestR2Key">[],
): string[] {
  return events.flatMap((event) => [event.bodyR2Key, event.requestR2Key]);
}

async function cleanupExpiredTemporaryEndpoints(
  deps: RunRetentionCleanupDeps,
  summary: RetentionCleanupSummary,
): Promise<void> {
  while (true) {
    const endpoints =
      await deps.endpointRepository.listExpiredTemporaryEndpoints(deps.now, {
        limit: CLEANUP_PAGE_SIZE,
      });

    if (endpoints.length === 0) {
      return;
    }

    for (const endpoint of endpoints) {
      let afterSequence: number | undefined;

      while (true) {
        const eventKeys =
          await deps.eventRepository.listEventObjectKeysForEndpoint(
            endpoint.id,
            {
              limit: CLEANUP_PAGE_SIZE,
              afterSequence,
            },
          );

        if (eventKeys.length === 0) {
          break;
        }

        summary.r2_objects_deleted += await deleteR2Objects(
          deps.requestBodyStore,
          objectKeysForEvents(eventKeys),
        );
        afterSequence = eventKeys.at(-1)?.sequence;
      }

      summary.temporary_events_deleted +=
        await deps.eventRepository.deleteEventsForEndpoint(endpoint.id);

      if (await deps.endpointRepository.deleteTemporaryEndpoint(endpoint.id)) {
        summary.expired_temporary_endpoints_deleted += 1;
      }
    }
  }
}

async function cleanupExpiredPrivateEndpoints(
  deps: RunRetentionCleanupDeps,
  summary: RetentionCleanupSummary,
): Promise<void> {
  while (true) {
    const endpoints = await deps.endpointRepository.listExpiredPrivateEndpoints(
      deps.now,
      {
        limit: CLEANUP_PAGE_SIZE,
      },
    );

    if (endpoints.length === 0) {
      return;
    }

    for (const endpoint of endpoints) {
      let deleted: DeletePrivateEndpointDataResult;

      try {
        deleted = await deletePrivateEndpointData({
          endpointId: endpoint.id,
          eventRepository: deps.eventRepository,
          endpointSecretRepository: deps.endpointSecretRepository,
          requestBodyStore: deps.requestBodyStore,
          deleteEndpointRecord: () =>
            deps.endpointRepository.deletePrivateEndpoint(endpoint.id),
        });
      } catch (error) {
        if (error instanceof RequestBodyObjectDeleteError) {
          throw new CleanupR2DeleteError();
        }

        throw error;
      }

      summary.r2_objects_deleted += deleted.deleted_body_objects;
      summary.expired_private_endpoint_events_deleted += deleted.deleted_events;

      if (deleted.endpoint_deleted) {
        summary.expired_private_endpoints_deleted += 1;
      }
    }
  }
}

async function cleanupExpiredPrivateEvents(
  deps: RunRetentionCleanupDeps,
  summary: RetentionCleanupSummary,
): Promise<void> {
  const cutoff = new Date(deps.now.getTime() - PRIVATE_EVENT_RETENTION_MS);
  let afterSequence: number | undefined;

  while (true) {
    const events = await deps.eventRepository.listExpiredPrivateEventObjectKeys(
      cutoff,
      {
        limit: CLEANUP_PAGE_SIZE,
        afterSequence,
      },
    );

    if (events.length === 0) {
      return;
    }

    summary.r2_objects_deleted += await deleteR2Objects(
      deps.requestBodyStore,
      objectKeysForEvents(events),
    );

    const deletedEvents = await deps.eventRepository.deleteEventsByIds(
      events.map((event) => event.eventId),
    );
    summary.private_events_deleted += deletedEvents.length;

    afterSequence = events.at(-1)?.sequence;
  }
}

function eventIdFromRequestBodyObjectKey(key: string): EventId | null {
  const match =
    /^events\/[^/]+\/\d{4}\/\d{2}\/\d{2}\/(evt_[^/]+)\/(?:body\.raw|request\.json)$/.exec(
      key,
    );

  return match === null ? null : (match[1] as EventId);
}

async function cleanupOrphanObjects(
  deps: RunRetentionCleanupDeps,
  summary: RetentionCleanupSummary,
): Promise<void> {
  const cutoff = new Date(deps.now.getTime() - ORPHAN_CLEANUP_MIN_AGE_MS);
  let cursor: string | undefined;
  const orphanKeys: string[] = [];

  while (true) {
    const page = await deps.requestBodyStore.listObjects({
      prefix: "events/",
      cursor,
      limit: R2_OBJECT_LIST_LIMIT,
    });
    for (const object of page.objects) {
      if (object.uploaded.getTime() > cutoff.getTime()) {
        continue;
      }

      const eventId = eventIdFromRequestBodyObjectKey(object.key);

      if (eventId === null) {
        continue;
      }

      if (!(await deps.eventRepository.eventExists(eventId))) {
        orphanKeys.push(object.key);
      }
    }

    if (!page.truncated) {
      break;
    }

    cursor = page.cursor;
  }

  summary.orphan_objects_deleted += await deleteR2Objects(
    deps.requestBodyStore,
    orphanKeys,
  );
  summary.r2_objects_deleted += orphanKeys.length;
}

/** @public */
export async function runRetentionCleanup(
  deps: RunRetentionCleanupDeps,
): Promise<RetentionCleanupSummary> {
  const summary: RetentionCleanupSummary = {
    expired_temporary_endpoints_deleted: 0,
    temporary_events_deleted: 0,
    expired_private_endpoints_deleted: 0,
    expired_private_endpoint_events_deleted: 0,
    private_events_deleted: 0,
    orphan_objects_deleted: 0,
    r2_objects_deleted: 0,
  };

  await cleanupExpiredTemporaryEndpoints(deps, summary);
  await cleanupExpiredPrivateEndpoints(deps, summary);
  await cleanupExpiredPrivateEvents(deps, summary);
  await deps.endpointRepository.reconcilePrivateEndpointEventCounts();
  await cleanupOrphanObjects(deps, summary);

  return summary;
}
