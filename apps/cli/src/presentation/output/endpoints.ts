import type {
  EndpointSecretCreateResponse,
  EndpointSecretMetadata,
  EndpointSecretRevokeResponse,
} from "@barestash/shared/endpoint-secrets";
import type { EndpointMetadata } from "@barestash/shared/endpoints";

import type { CliIo } from "../../domain/ports.js";

/** @public */
export function printEndpointCreated(
  io: CliIo,
  endpoint: EndpointMetadata,
): void {
  io.stdout(`Created endpoint: ${endpoint.id}`);
  io.stdout("");
  io.stdout("Webhook URL:");
  io.stdout(endpoint.ingest_url);
  io.stdout("");
  io.stdout("Append a path suffix when the webhook provider requires it:");
  io.stdout(`${endpoint.ingest_url}/github/push`);
  io.stdout("");
  io.stdout(`Mode: ${endpoint.mode}`);
  io.stdout(`Expires: ${endpoint.expires_at}`);
  io.stdout(
    `Events: ${endpoint.event_count} / ${endpoint.event_limit ?? "unlimited"}`,
  );
}

/** @public */
export function printEndpointList(
  io: CliIo,
  endpoints: EndpointMetadata[],
): void {
  io.stdout("ID          NAME          MODE        EVENTS      EXPIRES");

  for (const endpoint of endpoints) {
    const name = endpoint.name ?? "-";
    const events = `${endpoint.event_count}/${endpoint.event_limit ?? "-"}`;
    io.stdout(
      `${endpoint.id}  ${name}  ${endpoint.mode}  ${events}  ${endpoint.expires_at}`,
    );
  }
}

/** @public */
export function printEndpointDetail(
  io: CliIo,
  endpoint: EndpointMetadata,
): void {
  io.stdout(`Endpoint: ${endpoint.id}`);
  io.stdout(`Name: ${endpoint.name ?? "-"}`);
  io.stdout(`Webhook URL: ${endpoint.ingest_url}`);
  io.stdout(`Mode: ${endpoint.mode}`);
  io.stdout(`Expires: ${endpoint.expires_at}`);
  io.stdout(
    `Events: ${endpoint.event_count} / ${endpoint.event_limit ?? "unlimited"}`,
  );
  io.stdout(
    `Public read: ${endpoint.public_read ? "yes (no authentication required)" : "no"}`,
  );
  io.stdout(`Created: ${endpoint.created_at}`);
}

/** @public */
export function printEndpointSecretCreated(
  io: CliIo,
  result: EndpointSecretCreateResponse,
): void {
  io.stdout(`Created secret: ${result.endpoint_secret.id}`);
  io.stdout("");
  io.stdout("Secret (shown once):");
  io.stdout(result.secret);
  io.stdout("");
  io.stdout("Save this secret now. It will not be shown again.");
  io.stdout("");
  io.stdout("Configure your webhook provider to send:");
  io.stdout(`  x-barestash-secret: ${result.secret}`);
}

/** @public */
export function printEndpointSecretList(
  io: CliIo,
  secrets: EndpointSecretMetadata[],
): void {
  io.stdout("ID          STATUS   CREATED               LAST_USED");

  for (const secret of secrets) {
    io.stdout(
      `${secret.id}  ${secret.status}  ${secret.created_at}  ${secret.last_used_at ?? "never"}`,
    );
  }
}

/** @public */
export function printEndpointSecretRevoked(
  io: CliIo,
  result: EndpointSecretRevokeResponse,
): void {
  io.stdout(`Revoked secret: ${result.endpoint_secret.id}`);
}
