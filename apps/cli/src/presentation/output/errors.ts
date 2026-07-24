import type { RestErrorResponse } from "@barestash/shared/errors";

import type { CliIo } from "../../domain/ports.js";

/** @public */
export function printNoEndpointSelected(io: CliIo): void {
  io.stderr("No endpoint selected.");
  io.stderr("");
  io.stderr("Run:");
  io.stderr("  barestash endpoints create");
  io.stderr("");
  io.stderr("Or specify:");
  io.stderr("  --endpoint ep_abc123");
}

/** @public */
export function printApiError(io: CliIo, error: RestErrorResponse): void {
  io.stderr(error.error.message);

  if (error.error.code === "endpoint_expired") {
    io.stderr("");
    io.stderr("Run:");
    io.stderr("  barestash endpoints create");
  }

  if (error.error.code === "event_limit_exceeded") {
    io.stderr("");
    io.stderr(
      "Create a new endpoint if you need to continue capturing events:",
    );
    io.stderr("  barestash endpoints create");
  }

  if (error.error.code === "temporary_endpoint_delete_not_supported") {
    io.stderr("");
    io.stderr("Temporary endpoints expire automatically after 24 hours.");
    io.stderr("Deletion is not supported in MVP.");
    io.stderr("");
    io.stderr("Create a new temporary endpoint if needed:");
    io.stderr("  barestash endpoints create --temporary");
  }

  if (error.error.code === "endpoint_not_found") {
    io.stderr("");
    io.stderr("Run:");
    io.stderr("  barestash endpoints create");
    io.stderr("  barestash endpoints list");
  }

  if (error.error.code === "not_authenticated") {
    io.stderr("");
    io.stderr("Run:");
    io.stderr("  barestash auth login");
  }

  if (
    [
      "refresh_token_expired",
      "refresh_token_revoked",
      "refresh_token_reuse_detected",
      "session_expired",
      "session_revoked",
      "account_disabled",
    ].includes(error.error.code)
  ) {
    io.stderr("");
    io.stderr("Authenticate again:");
    io.stderr("  barestash auth login");
  }

  if (error.error.code === "personal_access_token_expired") {
    io.stderr("");
    io.stderr(
      "Create a new Personal Access Token from an interactive session:",
    );
    io.stderr("  barestash tokens create");
  }

  if (error.error.code === "insufficient_scope") {
    io.stderr("");
    io.stderr(
      "Create a token with the required scopes from an interactive session:",
    );
    io.stderr("  barestash tokens create");
  }
}

export function printLocalError(io: CliIo, message: string): void {
  if (message.length > 0) {
    io.stderr(message);
  }
}

export function printAuthLoginDeferred(io: CliIo): void {
  io.stderr("Browser login is deferred for the MVP.");
  io.stderr("Use:");
  io.stderr('  echo "$BARESTASH_TOKEN" | barestash auth login --with-token');
}

/** @public */
export function printStreamReadError(io: CliIo, error: unknown): void {
  io.stderr("Failed to read Barestash event stream.");

  if (error instanceof Error && error.message.length > 0) {
    io.stderr(error.message);
  }
}

/** @public */
export function printApiConnectivityError(io: CliIo, error: unknown): void {
  io.stderr("Failed to reach Barestash API.");

  if (error instanceof Error && error.message.length > 0) {
    io.stderr(error.message);
  }
}
