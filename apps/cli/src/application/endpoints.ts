import type {
  EndpointSecretCreateResponse,
  EndpointSecretListResponse,
  EndpointSecretRevokeResponse,
} from "@barestash/shared/endpoint-secrets";
import type {
  EndpointDeleteResponse,
  EndpointListResponse,
  EndpointResponse,
} from "@barestash/shared/endpoints";

import type { Confirmer } from "../domain/ports.js";
import { type AuthDeps, authHeaders } from "./auth.js";
import { type CliResult, fromApiCall, localError } from "./result.js";

export type EndpointDeps = AuthDeps;

/** @public */
export async function createTemporaryEndpoint(
  deps: EndpointDeps,
  name: string | undefined,
): Promise<CliResult<EndpointResponse>> {
  const body = {
    mode: "temporary",
    ...(name === undefined ? {} : { name }),
  };
  const result = await deps.apiClient.request<EndpointResponse>(
    "/v1/endpoints",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return fromApiCall(result);
}

/** @public */
export async function createPrivateEndpoint(
  deps: EndpointDeps,
  name: string | undefined,
): Promise<CliResult<EndpointResponse>> {
  const body = {
    mode: "private",
    ...(name === undefined ? {} : { name }),
  };
  const result = await deps.apiClient.request<EndpointResponse>(
    "/v1/endpoints",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders(deps)),
      },
      body: JSON.stringify(body),
    },
  );

  return fromApiCall(result);
}

/** @public */
export async function listEndpoints(
  deps: EndpointDeps,
): Promise<CliResult<EndpointListResponse>> {
  const result = await deps.apiClient.request<EndpointListResponse>(
    "/v1/endpoints",
    {
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

/** @public */
export async function showEndpoint(
  deps: EndpointDeps,
  endpointId: string,
): Promise<CliResult<EndpointResponse>> {
  const result = await deps.apiClient.request<EndpointResponse>(
    `/v1/endpoints/${endpointId}`,
    {
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

/** @public */
export async function createEndpointSecret(
  deps: EndpointDeps,
  endpointId: string,
): Promise<CliResult<EndpointSecretCreateResponse>> {
  const result = await deps.apiClient.request<EndpointSecretCreateResponse>(
    `/v1/endpoints/${endpointId}/secrets`,
    {
      method: "POST",
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

/** @public */
export async function listEndpointSecrets(
  deps: EndpointDeps,
  endpointId: string,
): Promise<CliResult<EndpointSecretListResponse>> {
  const result = await deps.apiClient.request<EndpointSecretListResponse>(
    `/v1/endpoints/${endpointId}/secrets`,
    {
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

export type RevokeEndpointSecretDeps = EndpointDeps & {
  confirmer: Confirmer;
};

/** @public */
export async function revokeEndpointSecret(
  deps: RevokeEndpointSecretDeps,
  endpointId: string,
  secretId: string,
  yes: boolean,
): Promise<CliResult<EndpointSecretRevokeResponse>> {
  if (!yes) {
    const confirmed = await deps.confirmer.confirm(
      `Revoke secret ${secretId}?`,
    );

    if (!confirmed) {
      return localError("Endpoint secret revocation cancelled.");
    }
  }

  const result = await deps.apiClient.request<EndpointSecretRevokeResponse>(
    `/v1/endpoints/${endpointId}/secrets/${secretId}`,
    {
      method: "DELETE",
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}

export type DeleteEndpointDeps = EndpointDeps & {
  confirmer: Confirmer;
};

/** @public */
export async function deleteEndpoint(
  deps: DeleteEndpointDeps,
  endpointId: string,
  yes: boolean,
): Promise<CliResult<EndpointDeleteResponse>> {
  if (!yes) {
    const confirmed = await deps.confirmer.confirm(
      `Delete endpoint ${endpointId} and all events?`,
    );

    if (!confirmed) {
      return localError("Endpoint deletion cancelled.");
    }
  }

  const result = await deps.apiClient.request<EndpointDeleteResponse>(
    `/v1/endpoints/${endpointId}`,
    {
      method: "DELETE",
      headers: await authHeaders(deps),
    },
  );

  return fromApiCall(result);
}
