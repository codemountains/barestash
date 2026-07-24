import type { StoredEndpoint } from "./endpoint.js";
import type { StoredEndpointSecret } from "./endpoint-secret.js";
import type { EventMetadataInsert } from "./event.js";
import type { CreateEventResult } from "./ports.js";

/** @public */
export function evaluateCreateEventGuard(
  input: EventMetadataInsert,
  endpoint: StoredEndpoint | null,
  activeSecrets: StoredEndpointSecret[],
): CreateEventResult | "allowed" {
  const endpointActive = endpoint !== null && endpoint.status === "active";

  if (!endpointActive) {
    return { status: "endpoint_inactive" };
  }

  if (input.matched_secret_id === null) {
    if (activeSecrets.length > 0) {
      return { status: "active_secret_required" };
    }

    return "allowed";
  }

  const matchedSecretActive = activeSecrets.some(
    (secret) => secret.id === input.matched_secret_id,
  );

  if (!matchedSecretActive) {
    return { status: "matched_secret_inactive" };
  }

  return "allowed";
}

/** @public */
export function classifyFailedCreateEvent(
  endpointActive: boolean,
  matchedSecretId: string | null,
): CreateEventResult {
  if (endpointActive && matchedSecretId !== null) {
    return { status: "matched_secret_inactive" };
  }

  if (endpointActive) {
    return { status: "active_secret_required" };
  }

  return { status: "endpoint_inactive" };
}
