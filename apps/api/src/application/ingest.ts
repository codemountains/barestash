import type { EndpointId, EventId } from "@barestash/shared/ids";

// biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
import { CompensationStack } from "./ingest/compensation.js";
import {
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  IngestPhaseError,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  persistRawRequest,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  publishLive,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  recordMetadata,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  reserveCapacity,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  validateEndpoint,
  // biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
  verifySecret,
} from "./ingest/phases.js";
// biome-ignore lint/correctness/noPrivateImports: This public entry owns the private ingest implementation.
import type { IngestDeps } from "./ingest/types.js";
import { err, ok, type UseCaseResult } from "./result.js";

export type IngestResult = {
  eventId: EventId;
  endpointId: EndpointId;
};

/** @public */
export async function ingestRequest(
  deps: IngestDeps,
): Promise<UseCaseResult<IngestResult>> {
  const compensations = new CompensationStack();

  try {
    const endpoint = await validateEndpoint(deps);
    await reserveCapacity(deps, endpoint, compensations);
    const secretVerification = await verifySecret(deps, endpoint);
    const persistedRequest = await persistRawRequest(deps, compensations);
    const eventMetadata = await recordMetadata(
      deps,
      endpoint,
      persistedRequest,
      secretVerification,
    );

    compensations.clear();
    await publishLive(deps, eventMetadata, persistedRequest);

    return ok({ eventId: eventMetadata.id, endpointId: deps.endpointId });
  } catch (error) {
    await compensations.run();

    if (error instanceof IngestPhaseError) {
      return error.result;
    }

    return err("internal_error", "Failed to process ingest request.", 500);
  }
}
