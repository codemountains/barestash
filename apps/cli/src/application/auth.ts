import type {
  AccountResponse,
  DeviceAuthorizationCreateResponse,
  DeviceTokenResponse,
  RefreshTokenResponse,
} from "@barestash/shared/auth";
import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import { parseBearerTokenString } from "@barestash/shared/bearer-tokens";
import { ID_PREFIXES } from "@barestash/shared/ids";
import type { PersonalAccessTokenRevokeResponse } from "@barestash/shared/personal-access-tokens";

import type { StoredCredential } from "../domain/credential.js";
import type {
  ConfigStore,
  CredentialLock,
  CredentialStore,
  CredentialWriteResult,
} from "../domain/ports.js";
import type {
  ApiCallResult,
  FetchApiClient,
} from "../infrastructure/api/client.js";
import {
  CliApiErrorException,
  type CliResult,
  fromApiCall,
  localError,
  ok,
} from "./result.js";

export const INVALID_PROVIDED_TOKEN_MESSAGE =
  "Unable to validate the provided token.";
export const INVALID_STORED_TOKEN_MESSAGE =
  "Unable to validate the stored authentication token.";
const REFRESH_WINDOW_MILLISECONDS = 5 * 60 * 1_000;
const ISSUED_SESSION_CLEANUP_WARNING =
  "Unable to revoke the newly issued CLI session. The newly issued remote CLI session may still be active.";
const EXPIRED_CREDENTIAL_CLEANUP_WARNING =
  "Unable to clear the expired stored authentication credential. Run `barestash auth logout` after the credential store becomes available.";
const ROTATED_CREDENTIAL_CLEANUP_WARNING =
  "Unable to clear the stale stored authentication credential after refresh persistence failed. Run `barestash auth logout` before authenticating again.";
const ROTATED_SESSION_CLEANUP_WARNING =
  "Unable to revoke the rotated CLI session after refresh persistence failed. The remote CLI session may still be active.";
const LEGACY_CONFIG_CLEANUP_WARNING =
  "Unable to remove the legacy authentication token from the config file. The newly stored credential will still be used.";

export type AuthDeps = {
  env: Record<string, string | undefined>;
  configStore: ConfigStore;
  apiClient: FetchApiClient;
};

/** @public */
export type SessionAuthDeps = AuthDeps & {
  credentialStore: CredentialStore;
  credentialLock: CredentialLock;
  now: () => Date;
  warn: (message: string) => void;
  credentialStoreUsesConfig: boolean;
};

export async function resolveAuthToken(deps: AuthDeps): Promise<string | null> {
  const envToken = deps.env.BARESTASH_TOKEN;
  if (envToken !== undefined && envToken.length > 0) return envToken;

  if (!hasSessionDeps(deps)) {
    return (await deps.configStore.read()).token ?? null;
  }
  return deps.credentialLock.withLock(async () => {
    const credential = await readStoredCredential(deps);
    if (credential === null) return null;
    if (credential.type === "personal_access_token") return credential.token;
    if (
      Date.parse(credential.access_token_expires_at) - deps.now().getTime() >
      REFRESH_WINDOW_MILLISECONDS
    ) {
      return credential.access_token;
    }
    return refreshCredential(deps, credential);
  });
}

/** @public */
export async function refreshAfterAccessTokenExpired(
  deps: SessionAuthDeps,
  expiredAccessToken: string,
): Promise<string | null> {
  if ((deps.env.BARESTASH_TOKEN?.length ?? 0) > 0) return null;
  return deps.credentialLock.withLock(async () => {
    const credential = await readStoredCredential(deps);
    if (credential?.type !== "cli_session") return null;
    if (credential.access_token !== expiredAccessToken) {
      return credential.access_token;
    }
    return refreshCredential(deps, credential);
  });
}

export async function authHeaders(
  deps: AuthDeps,
): Promise<Record<string, string>> {
  const token = await resolveAuthToken(deps);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

export async function validateToken(
  deps: AuthDeps,
  token: string,
): Promise<CliResult<AccountResponse>> {
  return fromApiCall(
    await deps.apiClient.request<AccountResponse>("/v1/account", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

export type LoginDeps = SessionAuthDeps & {
  readStdin: () => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  openBrowser: (url: string) => Promise<boolean>;
  deviceName: string;
  onDeviceAuthorization: (
    authorization: DeviceAuthorizationCreateResponse,
  ) => void;
};

export type AuthLoginResult = {
  principal: AccountResponse;
  storage: CredentialWriteResult;
  replacedSession: boolean;
  sessionExpiresAt: string | null;
};

/** @public */
export async function authLogin(
  deps: LoginDeps,
  options: { withToken: boolean; insecureStorage: boolean },
): Promise<CliResult<AuthLoginResult>> {
  if (options.withToken) {
    const token = (await deps.readStdin()).trim();
    if (token.length === 0) return localError("No token provided on stdin.");
    const metadataResult = await validateToken(deps, token);
    if (metadataResult.kind !== "ok") return metadataResult;
    if (metadataResult.value.credential.type !== "personal_access_token") {
      return localError(
        "auth login --with-token requires a Personal Access Token.",
      );
    }
    const persisted = await persistLoginCredential(
      deps,
      { type: "personal_access_token", token },
      options.insecureStorage,
    );
    return ok({
      principal: metadataResult.value,
      ...persisted,
      sessionExpiresAt: null,
    });
  }

  const created =
    await deps.apiClient.request<DeviceAuthorizationCreateResponse>(
      "/v1/auth/device/authorizations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "barestash-cli",
          client_version: "0.0.0",
          device_name: deps.deviceName,
          requested_scopes: AUTHORIZATION_SCOPES,
        }),
      },
    );
  if (created.kind === "error") return fromApiCall(created);
  deps.onDeviceAuthorization(created.value);
  await deps.openBrowser(created.value.verification_uri_complete);

  let interval = created.value.interval;
  const expiresAt = deps.now().getTime() + created.value.expires_in * 1_000;
  while (deps.now().getTime() < expiresAt) {
    await deps.sleep(interval * 1_000);
    const polled = await deps.apiClient.request<DeviceTokenResponse>(
      "/v1/auth/device/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: created.value.device_code }),
      },
    );
    if (polled.kind === "error") {
      if (polled.error.error.code === "authorization_pending") {
        continue;
      }
      if (polled.error.error.code === "slow_down") {
        interval += 5;
        continue;
      }
      return fromApiCall(polled);
    }
    const now = deps.now();
    let principal: CliResult<AccountResponse>;
    try {
      principal = await validateTokenWithoutRefresh(
        deps,
        polled.value.access_token,
      );
    } catch (error) {
      await revokeCliSessionBestEffort(deps, polled.value.access_token);
      throw error;
    }
    if (principal.kind !== "ok") {
      await revokeCliSessionBestEffort(deps, polled.value.access_token);
      return principal;
    }
    if (principal.value.credential.type !== "cli_access_token") {
      await revokeCliSessionBestEffort(deps, polled.value.access_token);
      return localError("Device Authorization did not issue a CLI session.");
    }
    const credential: StoredCredential = {
      type: "cli_session",
      session_id: principal.value.credential.session_id,
      access_token: polled.value.access_token,
      refresh_token: polled.value.refresh_token,
      access_token_expires_at: addSeconds(
        now,
        polled.value.expires_in,
      ).toISOString(),
      refresh_token_expires_at: addSeconds(
        now,
        polled.value.refresh_token_expires_in,
      ).toISOString(),
      scopes: polled.value.scopes,
    };
    let persisted: Pick<AuthLoginResult, "storage" | "replacedSession">;
    try {
      persisted = await persistLoginCredential(
        deps,
        credential,
        options.insecureStorage,
      );
    } catch (error) {
      await revokeCliSessionBestEffort(deps, polled.value.access_token);
      throw error;
    }
    return ok({
      principal: principal.value,
      ...persisted,
      sessionExpiresAt: credential.refresh_token_expires_at,
    });
  }
  return localError("Device Authorization expired. Run auth login again.");
}

async function revokeCliSessionBestEffort(
  deps: SessionAuthDeps,
  accessToken: string,
  warning = ISSUED_SESSION_CLEANUP_WARNING,
): Promise<void> {
  try {
    const result = await deps.apiClient.requestWithoutAccessTokenRefresh(
      "/v1/auth/sessions/current/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
    );
    if (
      result.kind === "error" &&
      !["token_revoked", "session_revoked", "session_expired"].includes(
        result.error.error.code,
      )
    ) {
      deps.warn(warning);
    }
  } catch {
    deps.warn(warning);
  }
}

async function validateTokenWithoutRefresh(
  deps: AuthDeps,
  accessToken: string,
): Promise<CliResult<AccountResponse>> {
  return fromApiCall(
    await deps.apiClient.requestWithoutAccessTokenRefresh<AccountResponse>(
      "/v1/account",
      { headers: { authorization: `Bearer ${accessToken}` } },
    ),
  );
}

/** @public */
export async function authStatus(deps: SessionAuthDeps): Promise<
  CliResult<
    | { authenticated: false; defaultEndpoint: string | null }
    | {
        authenticated: true;
        principal: AccountResponse;
        defaultEndpoint: string | null;
      }
  >
> {
  const token = await resolveAuthToken(deps);
  const config = await deps.configStore.read();
  if (token === null) {
    return ok({
      authenticated: false,
      defaultEndpoint: config.default_endpoint ?? null,
    });
  }
  const metadataResult = await validateToken(deps, token);
  if (metadataResult.kind !== "ok") return metadataResult;
  return ok({
    authenticated: true,
    principal: metadataResult.value,
    defaultEndpoint: config.default_endpoint ?? null,
  });
}

/** @public */
export async function authLogout(
  deps: SessionAuthDeps,
  revoke: boolean,
): Promise<CliResult<void>> {
  const credential = await deps.credentialLock.withLock(() =>
    readStoredCredential(deps),
  );
  if (revoke && credential === null) {
    return localError("No stored authentication credential is configured.");
  }
  if (revoke && credential !== null) {
    const token =
      credential.type === "cli_session"
        ? credential.access_token
        : credential.token;
    const targetResult = await resolveLogoutRevokeTarget(
      deps,
      credential,
      token,
    );
    if (targetResult.kind !== "ok") return targetResult;
    const target = targetResult.value;
    if (target !== null) {
      const { allowAccessTokenRefresh, isCliSession, path } = target;
      const confirmedCodes = new Set(
        isCliSession
          ? ["token_revoked", "session_revoked", "session_expired"]
          : ["token_revoked", "personal_access_token_expired"],
      );
      const refreshConfirmedCodes = new Set([
        "session_revoked",
        "session_expired",
      ]);
      let result: ApiCallResult<PersonalAccessTokenRevokeResponse> | null;
      try {
        const init = {
          method: isCliSession ? "POST" : "DELETE",
          headers: { authorization: `Bearer ${token}` },
        };
        result = allowAccessTokenRefresh
          ? await deps.apiClient.request<PersonalAccessTokenRevokeResponse>(
              path,
              init,
            )
          : await deps.apiClient.requestWithoutAccessTokenRefresh<PersonalAccessTokenRevokeResponse>(
              path,
              init,
            );
      } catch (error) {
        if (
          !allowAccessTokenRefresh ||
          !isCliSession ||
          !(error instanceof CliApiErrorException) ||
          !refreshConfirmedCodes.has(error.error.error.code)
        ) {
          throw error;
        }
        result = null;
      }
      if (
        result !== null &&
        result.kind === "error" &&
        !confirmedCodes.has(result.error.error.code)
      ) {
        return fromApiCall(result);
      }
    }
  }
  await deps.credentialLock.withLock(async () => {
    const current = await readStoredCredential(deps);
    if (!revoke || credentialsEqual(current, credential)) {
      await clearStoredCredential(deps);
    }
  });
  return ok(undefined);
}

async function readStoredCredential(
  deps: SessionAuthDeps,
): Promise<StoredCredential | null> {
  const stored = await deps.credentialStore.read();
  if (stored !== null) return stored;
  const legacy = (await deps.configStore.read()).token;
  return legacy === undefined
    ? null
    : { type: "personal_access_token", token: legacy };
}

async function refreshCredential(
  deps: SessionAuthDeps,
  credential: Extract<StoredCredential, { type: "cli_session" }>,
): Promise<string> {
  const refreshed = await deps.apiClient.request<RefreshTokenResponse>(
    "/v1/auth/token/refresh",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: credential.refresh_token,
      }),
    },
  );
  if (refreshed.kind === "error") {
    if (
      [
        "refresh_token_expired",
        "refresh_token_revoked",
        "refresh_token_reuse_detected",
        "session_expired",
        "session_revoked",
        "account_disabled",
      ].includes(refreshed.error.error.code)
    ) {
      try {
        await deps.credentialStore.delete();
      } catch {
        deps.warn(EXPIRED_CREDENTIAL_CLEANUP_WARNING);
      }
    }
    throw new CliApiErrorException(refreshed.error);
  }
  const now = deps.now();
  const updated: StoredCredential = {
    ...credential,
    access_token: refreshed.value.access_token,
    refresh_token: refreshed.value.refresh_token,
    access_token_expires_at: addSeconds(
      now,
      refreshed.value.expires_in,
    ).toISOString(),
    refresh_token_expires_at: addSeconds(
      now,
      refreshed.value.refresh_token_expires_in,
    ).toISOString(),
  };
  let storage: CredentialWriteResult;
  try {
    storage = await deps.credentialStore.replace(updated);
  } catch (error) {
    await revokeCliSessionBestEffort(
      deps,
      updated.access_token,
      ROTATED_SESSION_CLEANUP_WARNING,
    );
    try {
      await deps.credentialStore.delete();
    } catch {
      deps.warn(ROTATED_CREDENTIAL_CLEANUP_WARNING);
    }
    throw error;
  }
  if (storage.storage === "plaintext") {
    deps.warn(
      `The OS credential store was unavailable; refreshed credentials were stored in plaintext at ${storage.path}.`,
    );
  }
  return updated.access_token;
}

type LogoutRevokeTarget = {
  allowAccessTokenRefresh: boolean;
  isCliSession: boolean;
  path: string;
};

async function resolveLogoutRevokeTarget(
  deps: SessionAuthDeps,
  credential: StoredCredential,
  token: string,
): Promise<CliResult<LogoutRevokeTarget | null>> {
  if (credential.type === "cli_session") {
    return ok({
      allowAccessTokenRefresh: true,
      isCliSession: true,
      path: "/v1/auth/sessions/current/revoke",
    });
  }

  const parsed = parseBearerTokenString(token);
  if (parsed?.type === "access") {
    return ok({
      allowAccessTokenRefresh: false,
      isCliSession: true,
      path: "/v1/auth/sessions/current/revoke",
    });
  }
  if (parsed?.type === "pat") {
    return ok({
      allowAccessTokenRefresh: false,
      isCliSession: false,
      path: `/v1/tokens/${ID_PREFIXES.token}${parsed.tokenIdSuffix}`,
    });
  }

  const metadata = await validateTokenWithoutRefresh(deps, token);
  if (metadata.kind !== "ok") {
    if (
      metadata.kind === "api-error" &&
      ["token_revoked", "personal_access_token_expired"].includes(
        metadata.error.error.code,
      )
    ) {
      return ok(null);
    }
    return metadata;
  }

  if (metadata.value.credential.type === "cli_access_token") {
    return ok({
      allowAccessTokenRefresh: false,
      isCliSession: true,
      path: "/v1/auth/sessions/current/revoke",
    });
  }
  return ok({
    allowAccessTokenRefresh: false,
    isCliSession: false,
    path: `/v1/tokens/${metadata.value.credential.id}`,
  });
}

async function persistLoginCredential(
  deps: SessionAuthDeps,
  credential: StoredCredential,
  insecure: boolean,
): Promise<Pick<AuthLoginResult, "storage" | "replacedSession">> {
  return deps.credentialLock.withLock(async () => {
    const previous = await readStoredCredential(deps);
    const storage = await deps.credentialStore.write(credential, { insecure });
    try {
      await clearLegacyConfigToken(deps);
    } catch {
      deps.warn(LEGACY_CONFIG_CLEANUP_WARNING);
    }
    return {
      storage,
      replacedSession: previous?.type === "cli_session",
    };
  });
}

async function clearStoredCredential(deps: SessionAuthDeps): Promise<void> {
  await clearLegacyConfigToken(deps);
  await deps.credentialStore.delete();
}

async function clearLegacyConfigToken(deps: SessionAuthDeps): Promise<void> {
  if (deps.credentialStoreUsesConfig) return;
  const config = await deps.configStore.read();
  if (config.token === undefined) return;
  const { token: _token, ...remaining } = config;
  await deps.configStore.write(remaining);
}

function credentialsEqual(
  left: StoredCredential | null,
  right: StoredCredential | null,
): boolean {
  if (JSON.stringify(left) === JSON.stringify(right)) return true;
  return (
    left?.type === "cli_session" &&
    right?.type === "cli_session" &&
    left.session_id === right.session_id
  );
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function hasSessionDeps(deps: AuthDeps): deps is SessionAuthDeps {
  return (
    "credentialStore" in deps &&
    "credentialLock" in deps &&
    "now" in deps &&
    "warn" in deps &&
    "credentialStoreUsesConfig" in deps
  );
}
