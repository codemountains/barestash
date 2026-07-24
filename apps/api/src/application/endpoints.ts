import type { AuthPrincipal } from "@barestash/shared/auth";
import type {
  EndpointSecretCreateResponse,
  EndpointSecretListResponse,
  EndpointSecretRevokeResponse,
} from "@barestash/shared/endpoint-secrets";
import type {
  CreateEndpointRequest,
  EndpointDeleteResponse,
  EndpointMetadata,
} from "@barestash/shared/endpoints";
import type { EndpointId, SecretId } from "@barestash/shared/ids";
import type { AuthDomainRepository } from "../domain/auth-domain.js";
import {
  addIngestUrl,
  isEndpointExpired,
  type StoredEndpoint,
} from "../domain/endpoint.js";
import { endpointSecretToMetadata } from "../domain/endpoint-secret.js";
import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
  RequestBodyStore,
} from "../domain/ports.js";
import {
  authenticateResourcePrincipal,
  type CredentialPepperDeps,
  requireEndpointOwner,
  requireScope,
} from "./auth.js";
import { hashCredential } from "./credential-hash.js";
import {
  deletePrivateEndpointData,
  PrivateEndpointEventReadError,
  RequestBodyObjectDeleteError,
} from "./delete-private-endpoint-data.js";
import { err, ok, type UseCaseResult } from "./result.js";

export type CreateEndpointDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  now: Date;
  makeEndpointId: () => EndpointId;
  authorizationHeader: string | null;
  requestUrl: string;
  ingestHostname?: string;
  body: CreateEndpointRequest;
};

/** @public */
export async function createEndpoint(
  deps: CreateEndpointDeps,
): Promise<UseCaseResult<{ endpoint: EndpointMetadata }>> {
  if (deps.body.mode !== "temporary") {
    const authenticated = await authenticateResourcePrincipal(
      deps.authorizationHeader,
      deps.tokenRepository,
      deps.now,
      { pepper: deps.credentialPepper ?? "" },
    );

    if (authenticated.kind === "error") {
      return authenticated;
    }

    const authorized = requireScope(authenticated.value, "endpoints:write");

    if (authorized.kind === "error") {
      return authorized;
    }

    if (deps.endpointRepository.createPrivateEndpoint === undefined) {
      return err(
        "internal_error",
        "Private endpoint storage is not configured.",
        500,
      );
    }

    try {
      const endpoint = await deps.endpointRepository.createPrivateEndpoint({
        id: deps.makeEndpointId(),
        accountId: authorized.value.accountId,
        name:
          typeof deps.body.name === "string" && deps.body.name.length > 0
            ? deps.body.name
            : null,
        now: deps.now,
      });

      return ok({
        endpoint: addIngestUrl(endpoint, deps.requestUrl, deps.ingestHostname),
      });
    } catch {
      return err("d1_write_failed", "Failed to create endpoint metadata.", 500);
    }
  }

  try {
    const endpoint = await deps.endpointRepository.createTemporaryEndpoint({
      id: deps.makeEndpointId(),
      name:
        typeof deps.body.name === "string" && deps.body.name.length > 0
          ? deps.body.name
          : null,
      now: deps.now,
    });

    return ok({
      endpoint: addIngestUrl(endpoint, deps.requestUrl, deps.ingestHostname),
    });
  } catch {
    return err("d1_write_failed", "Failed to create endpoint metadata.", 500);
  }
}

export type ListEndpointsDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  now: Date;
  authorizationHeader: string | null;
  requestUrl: string;
  ingestHostname?: string;
};

/** @public */
export async function listEndpoints(
  deps: ListEndpointsDeps,
): Promise<UseCaseResult<{ endpoints: EndpointMetadata[] }>> {
  const authenticated = await authenticateResourcePrincipal(
    deps.authorizationHeader,
    deps.tokenRepository,
    deps.now,
    { pepper: deps.credentialPepper ?? "" },
  );

  if (authenticated.kind === "error") {
    return authenticated;
  }

  const authorized = requireScope(authenticated.value, "endpoints:read");

  if (authorized.kind === "error") {
    return authorized;
  }

  const endpoints =
    deps.endpointRepository.listPrivateEndpoints === undefined
      ? []
      : await deps.endpointRepository.listPrivateEndpoints(
          authorized.value.accountId,
          deps.now,
        );

  return ok({
    endpoints: endpoints.map((endpoint) =>
      addIngestUrl(endpoint, deps.requestUrl, deps.ingestHostname),
    ),
  });
}

export type ShowEndpointDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  now: Date;
  authorizationHeader: string | null;
  requestUrl: string;
  ingestHostname?: string;
  endpointId: EndpointId;
};

/** @public */
export async function showEndpoint(
  deps: ShowEndpointDeps,
): Promise<UseCaseResult<{ endpoint: EndpointMetadata }>> {
  let endpoint: StoredEndpoint | null;

  try {
    endpoint = await deps.endpointRepository.findEndpoint(deps.endpointId);
  } catch {
    return err("internal_error", "Failed to read endpoint metadata.", 500);
  }

  if (endpoint === null) {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  if (endpoint.mode === "private") {
    const authenticated = await authenticateResourcePrincipal(
      deps.authorizationHeader,
      deps.tokenRepository,
      deps.now,
      { pepper: deps.credentialPepper ?? "" },
    );

    if (authenticated.kind === "error") {
      return authenticated;
    }

    const scoped = requireScope(authenticated.value, "endpoints:read");

    if (scoped.kind === "error") {
      return scoped;
    }

    const owned = requireEndpointOwner(scoped.value, endpoint);

    if (owned.kind === "error") {
      return owned;
    }

    if (
      endpoint.status === "expired" ||
      isEndpointExpired(endpoint, deps.now)
    ) {
      return err(
        "endpoint_expired",
        `Endpoint expired: ${deps.endpointId}`,
        410,
      );
    }

    if (endpoint.status !== "active") {
      return err(
        "endpoint_not_found",
        `Endpoint not found: ${deps.endpointId}`,
        404,
      );
    }
  }

  if (endpoint.mode === "temporary") {
    if (
      endpoint.status === "expired" ||
      isEndpointExpired(endpoint, deps.now)
    ) {
      return err(
        "endpoint_expired",
        `Endpoint expired: ${deps.endpointId}`,
        410,
      );
    }

    if (endpoint.status !== "active") {
      return err(
        "endpoint_not_found",
        `Endpoint not found: ${deps.endpointId}`,
        404,
      );
    }
  }

  return ok({
    endpoint: addIngestUrl(endpoint, deps.requestUrl, deps.ingestHostname),
  });
}

async function resolveOwnedPrivateEndpoint(deps: {
  endpointRepository: EndpointRepository;
  authentication: UseCaseResult<AuthPrincipal>;
  now: Date;
  endpointId: EndpointId;
}): Promise<
  UseCaseResult<{
    endpoint: StoredEndpoint;
    accountId: import("../domain/endpoint.js").AccountId;
  }>
> {
  let endpoint: StoredEndpoint | null;

  try {
    endpoint = await deps.endpointRepository.findEndpoint(deps.endpointId);
  } catch {
    return err("internal_error", "Failed to read endpoint metadata.", 500);
  }

  if (endpoint === null) {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  if (endpoint.mode !== "private") {
    return err(
      "invalid_request",
      `Endpoint secrets are only supported for private endpoints: ${deps.endpointId}`,
      400,
    );
  }

  if (deps.authentication.kind === "error") {
    return deps.authentication;
  }

  const scoped = requireScope(deps.authentication.value, "endpoints:write");

  if (scoped.kind === "error") {
    return scoped;
  }

  const owned = requireEndpointOwner(scoped.value, endpoint);

  if (owned.kind === "error") {
    return owned;
  }

  if (endpoint.status === "expired" || isEndpointExpired(endpoint, deps.now)) {
    return err("endpoint_expired", `Endpoint expired: ${deps.endpointId}`, 410);
  }

  if (endpoint.status !== "active") {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  return ok({ endpoint, accountId: owned.value.accountId });
}

export type CreateEndpointSecretDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  endpointSecretRepository: EndpointSecretRepository;
  authentication: UseCaseResult<AuthPrincipal>;
  now: Date;
  endpointId: EndpointId;
  makeSecretId: () => SecretId;
  makeEndpointSecret: () => string;
};

/** @public */
export async function createEndpointSecret(
  deps: CreateEndpointSecretDeps,
): Promise<UseCaseResult<EndpointSecretCreateResponse>> {
  const resolved = await resolveOwnedPrivateEndpoint({
    endpointRepository: deps.endpointRepository,
    authentication: deps.authentication,
    now: deps.now,
    endpointId: deps.endpointId,
  });

  if (resolved.kind === "error") {
    return resolved;
  }

  const secret = deps.makeEndpointSecret();
  const secretHash = await hashCredential(secret, {
    pepper: deps.credentialPepper ?? "",
  });

  try {
    const endpointSecret =
      await deps.endpointSecretRepository.createEndpointSecret({
        id: deps.makeSecretId(),
        endpointId: deps.endpointId,
        secretHash,
        now: deps.now,
      });

    return ok({
      endpoint_secret: endpointSecretToMetadata(endpointSecret),
      secret,
    });
  } catch {
    return err("d1_write_failed", "Failed to create endpoint secret.", 500);
  }
}

export type ListEndpointSecretsDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  endpointSecretRepository: EndpointSecretRepository;
  tokenRepository: AuthDomainRepository;
  now: Date;
  authorizationHeader: string | null;
  endpointId: EndpointId;
};

/** @public */
export async function listEndpointSecrets(
  deps: ListEndpointSecretsDeps,
): Promise<UseCaseResult<EndpointSecretListResponse>> {
  const authentication = await authenticateResourcePrincipal(
    deps.authorizationHeader,
    deps.tokenRepository,
    deps.now,
    { pepper: deps.credentialPepper ?? "" },
  );
  const resolved = await resolveOwnedPrivateEndpoint({
    endpointRepository: deps.endpointRepository,
    authentication,
    now: deps.now,
    endpointId: deps.endpointId,
  });

  if (resolved.kind === "error") {
    return resolved;
  }

  try {
    const secrets = await deps.endpointSecretRepository.listEndpointSecrets(
      deps.endpointId,
    );

    return ok({
      endpoint_secrets: secrets.map(endpointSecretToMetadata),
    });
  } catch {
    return err("internal_error", "Failed to read endpoint secrets.", 500);
  }
}

export type RevokeEndpointSecretDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  endpointSecretRepository: EndpointSecretRepository;
  authentication: UseCaseResult<AuthPrincipal>;
  now: Date;
  endpointId: EndpointId;
  secretId: SecretId;
};

/** @public */
export async function revokeEndpointSecret(
  deps: RevokeEndpointSecretDeps,
): Promise<UseCaseResult<EndpointSecretRevokeResponse>> {
  const resolved = await resolveOwnedPrivateEndpoint({
    endpointRepository: deps.endpointRepository,
    authentication: deps.authentication,
    now: deps.now,
    endpointId: deps.endpointId,
  });

  if (resolved.kind === "error") {
    return resolved;
  }

  try {
    const secret = await deps.endpointSecretRepository.revokeEndpointSecret(
      deps.endpointId,
      deps.secretId,
      deps.now.toISOString(),
    );

    if (secret === null) {
      return err(
        "endpoint_not_found",
        `Endpoint secret not found: ${deps.secretId}`,
        404,
      );
    }

    return ok({ endpoint_secret: endpointSecretToMetadata(secret) });
  } catch {
    return err("d1_write_failed", "Failed to revoke endpoint secret.", 500);
  }
}

export type DeleteEndpointDeps = {
  endpointRepository: EndpointRepository;
  endpointSecretRepository: EndpointSecretRepository;
  eventRepository: EventRepository;
  requestBodyStore: RequestBodyStore;
  authentication: UseCaseResult<AuthPrincipal>;
  now: Date;
  requestUrl: string;
  ingestHostname?: string;
  endpointId: EndpointId;
};

/** @public */
export async function deleteEndpoint(
  deps: DeleteEndpointDeps,
): Promise<UseCaseResult<EndpointDeleteResponse>> {
  let endpoint: StoredEndpoint | null;

  try {
    endpoint = await deps.endpointRepository.findEndpoint(deps.endpointId);
  } catch {
    return err("internal_error", "Failed to read endpoint metadata.", 500);
  }

  if (
    endpoint === null ||
    (endpoint.status !== "active" && endpoint.status !== "disabled")
  ) {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  if (endpoint.mode === "temporary") {
    return err(
      "temporary_endpoint_delete_not_supported",
      `Cannot delete temporary endpoint: ${deps.endpointId}. Temporary endpoints expire automatically after 24 hours.`,
      400,
    );
  }

  if (deps.authentication.kind === "error") {
    return deps.authentication;
  }

  const scoped = requireScope(deps.authentication.value, "endpoints:write");

  if (scoped.kind === "error") {
    return scoped;
  }

  const owned = requireEndpointOwner(scoped.value, endpoint);

  if (owned.kind === "error") {
    return owned;
  }

  if (endpoint.status === "active") {
    try {
      const disabled = await deps.endpointRepository.disableEndpoint(
        deps.endpointId,
        owned.value.accountId,
        deps.now.toISOString(),
      );

      if (!disabled) {
        return err(
          "d1_write_failed",
          "Failed to disable endpoint before deletion.",
          500,
        );
      }
    } catch {
      return err(
        "d1_write_failed",
        "Failed to disable endpoint before deletion.",
        500,
      );
    }
  }

  let deletedBodyObjects = 0;
  let deletedEvents: number;

  try {
    const deleted = await deletePrivateEndpointData({
      endpointId: deps.endpointId,
      eventRepository: deps.eventRepository,
      endpointSecretRepository: deps.endpointSecretRepository,
      requestBodyStore: deps.requestBodyStore,
      deleteEndpointRecord: () =>
        deps.endpointRepository
          .deleteEndpoint(deps.endpointId, owned.value.accountId)
          .then(() => true),
    });

    deletedBodyObjects = deleted.deleted_body_objects;
    deletedEvents = deleted.deleted_events;
  } catch (error) {
    if (error instanceof RequestBodyObjectDeleteError) {
      return err(
        "r2_write_failed",
        "Failed to delete request body objects.",
        500,
      );
    }

    if (error instanceof PrivateEndpointEventReadError) {
      return err(
        "internal_error",
        "Failed to read endpoint event objects.",
        500,
      );
    }

    return err("d1_write_failed", "Failed to delete endpoint metadata.", 500);
  }

  return ok({
    endpoint: addIngestUrl(endpoint, deps.requestUrl, deps.ingestHostname),
    deleted_events: deletedEvents,
    deleted_body_objects: deletedBodyObjects,
  });
}

export type ResolveReadableEndpointDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  tokenRepository: AuthDomainRepository;
  now: Date;
  authorizationHeader: string | null;
  endpointId: EndpointId;
};

export async function resolveReadableEndpoint(
  deps: ResolveReadableEndpointDeps,
): Promise<UseCaseResult<StoredEndpoint>> {
  let endpoint: StoredEndpoint | null;

  try {
    endpoint = await deps.endpointRepository.findEndpoint(deps.endpointId);
  } catch {
    return err("internal_error", "Failed to read endpoint metadata.", 500);
  }

  if (endpoint === null) {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  if (endpoint.mode === "private") {
    const authenticated = await authenticateResourcePrincipal(
      deps.authorizationHeader,
      deps.tokenRepository,
      deps.now,
      { pepper: deps.credentialPepper ?? "" },
    );

    if (authenticated.kind === "error") {
      return authenticated;
    }

    const scoped = requireScope(authenticated.value, "events:read");

    if (scoped.kind === "error") {
      return scoped;
    }

    const owned = requireEndpointOwner(scoped.value, endpoint);

    if (owned.kind === "error") {
      return owned;
    }
  }

  if (endpoint.status === "expired" || isEndpointExpired(endpoint, deps.now)) {
    return err("endpoint_expired", `Endpoint expired: ${deps.endpointId}`, 410);
  }

  if (endpoint.status !== "active") {
    return err(
      "endpoint_not_found",
      `Endpoint not found: ${deps.endpointId}`,
      404,
    );
  }

  return ok(endpoint);
}
