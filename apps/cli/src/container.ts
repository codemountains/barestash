import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";

import {
  refreshAfterAccessTokenExpired,
  type SessionAuthDeps,
} from "./application/auth.js";
import type { StoredCredential } from "./domain/credential.js";
import type {
  CliFetch,
  CliIo,
  Confirmer,
  CredentialLock,
  CredentialStore,
  CredentialWriteResult,
  Sleeper,
  StdinReader,
} from "./domain/ports.js";
import {
  formatApiHost,
  resolveApiBaseUrl,
} from "./infrastructure/api/api-url.js";
import { FetchApiClient } from "./infrastructure/api/client.js";
import { createSecureFetch } from "./infrastructure/api/secure-fetch.js";
import { SystemBrowserOpener } from "./infrastructure/browser.js";
import { FileConfigStore } from "./infrastructure/config/file-config-store.js";
import {
  CredentialStoreChain,
  createSystemKeyring,
} from "./infrastructure/credentials/credential-store.js";
import { FileCredentialLock } from "./infrastructure/credentials/file-lock.js";
import {
  ProcessStdinReader,
  ReadlineConfirmer,
  TimerSleeper,
} from "./infrastructure/terminal.js";

export const DEFAULT_API_URL = "http://localhost:8787";

export type CliOptions = {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  allowInsecureApiUrl?: boolean;
  logApiHost?: boolean;
  fetch?: CliFetch;
  maxTailPolls?: number;
  maxStreamReconnects?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  readStdin?: () => Promise<string>;
  readConfig?: (path: string) => Promise<string | null>;
  writeConfig?: (path: string, value: string) => Promise<void>;
  deleteConfig?: (path: string) => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
  now?: () => Date;
  deviceName?: string;
  openBrowser?: (url: string) => Promise<boolean>;
  readCredential?: () => Promise<StoredCredential | null>;
  writeCredential?: (
    credential: StoredCredential,
    options: { insecure: boolean },
  ) => Promise<CredentialWriteResult>;
  replaceCredential?: (
    credential: StoredCredential,
  ) => Promise<CredentialWriteResult> | Promise<void>;
  deleteCredential?: () => Promise<void>;
  credentialLock?: CredentialLock;
};

export type CliState = {
  exitCode: number;
};

export type AppDeps = {
  io: CliIo;
  env: Record<string, string | undefined>;
  options: CliOptions;
  state: CliState;
  authDeps: SessionAuthDeps;
  stdinReader: StdinReader;
  confirmer: Confirmer;
  sleeper: Sleeper;
  browserOpener: SystemBrowserOpener;
  now: () => Date;
  deviceName: string;
};

function getEnv(options: CliOptions): Record<string, string | undefined> {
  return options.env ?? process.env;
}

function getFetch(options: CliOptions): CliFetch {
  return options.fetch ?? fetch;
}

function getAllowInsecureApiUrl(options: CliOptions): boolean {
  if (options.allowInsecureApiUrl === true) {
    return true;
  }

  const envValue = getEnv(options).BARESTASH_ALLOW_INSECURE_API_URL;

  return envValue === "1" || envValue === "true";
}

function createValidatedBaseUrlResolver(options: CliOptions): () => string {
  let resolvedBaseUrl: string | undefined;
  const rawUrl = getEnv(options).BARESTASH_API_URL ?? DEFAULT_API_URL;

  return () => {
    if (resolvedBaseUrl === undefined) {
      resolvedBaseUrl = resolveApiBaseUrl(rawUrl, {
        allowInsecure: getAllowInsecureApiUrl(options),
      });
    }

    return resolvedBaseUrl;
  };
}

function createLazyLoggingFetch(
  io: CliIo,
  fetchImpl: CliFetch,
  getBaseUrl: () => string,
  shouldLog: boolean,
): CliFetch {
  let logged = false;

  return async (input, init) => {
    if (shouldLog && !logged) {
      io.stderr(`Barestash API host: ${formatApiHost(getBaseUrl())}`);
      logged = true;
    }

    return fetchImpl(input, init);
  };
}

function shouldLogApiHost(options: CliOptions): boolean {
  if (options.logApiHost !== undefined) {
    return options.logApiHost;
  }

  return options.fetch === undefined;
}

export function createAppDeps(
  io: CliIo,
  options: CliOptions,
  state: CliState,
): AppDeps {
  const env = getEnv(options);
  const configStore = new FileConfigStore({
    env,
    platformName: platform(),
    homeDirectory: homedir(),
    readConfig: options.readConfig,
    writeConfig: options.writeConfig,
    deleteConfig: options.deleteConfig,
  });
  const configDirectory = dirname(configStore.path());
  const credentialStore = createCredentialStore(
    options,
    configDirectory,
    configStore,
  );
  const credentialStoreUsesConfig =
    options.readCredential === undefined &&
    options.writeCredential === undefined &&
    options.deleteCredential === undefined &&
    (options.readConfig !== undefined ||
      options.writeConfig !== undefined ||
      options.deleteConfig !== undefined);
  const usesInjectedStorage =
    options.readCredential !== undefined ||
    options.writeCredential !== undefined ||
    options.deleteCredential !== undefined ||
    options.readConfig !== undefined ||
    options.writeConfig !== undefined ||
    options.deleteConfig !== undefined;
  const credentialLock =
    options.credentialLock ??
    (usesInjectedStorage
      ? { withLock: <T>(operation: () => Promise<T>) => operation() }
      : new FileCredentialLock({
          path: join(configDirectory, "credentials.lock"),
        }));
  const getBaseUrl = createValidatedBaseUrlResolver(options);
  const allowInsecureApiUrl = getAllowInsecureApiUrl(options);
  const secureFetch = createSecureFetch(getFetch(options), {
    allowInsecure: allowInsecureApiUrl,
  });
  const apiClient = new FetchApiClient(
    shouldLogApiHost(options)
      ? createLazyLoggingFetch(io, secureFetch, getBaseUrl, true)
      : secureFetch,
    getBaseUrl,
    options.signal,
  );
  const authDeps: SessionAuthDeps = {
    env,
    configStore,
    credentialStore,
    credentialLock,
    apiClient,
    now: options.now ?? (() => new Date()),
    warn: (message) => io.stderr(message),
    credentialStoreUsesConfig,
  };
  apiClient.setAccessTokenExpiredHandler((expiredToken) =>
    refreshAfterAccessTokenExpired(authDeps, expiredToken),
  );

  return {
    io,
    env,
    options,
    state,
    authDeps,
    stdinReader: new ProcessStdinReader(options.readStdin),
    confirmer: new ReadlineConfirmer(options.confirm),
    sleeper: new TimerSleeper(options.sleep, options.signal),
    browserOpener: new SystemBrowserOpener(platform(), options.openBrowser),
    now: options.now ?? (() => new Date()),
    deviceName: options.deviceName ?? hostname(),
  };
}

function createCredentialStore(
  options: CliOptions,
  configDirectory: string,
  configStore: FileConfigStore,
): CredentialStore {
  if (
    options.readCredential !== undefined ||
    options.writeCredential !== undefined ||
    options.deleteCredential !== undefined
  ) {
    return {
      read: options.readCredential ?? (async () => null),
      write:
        options.writeCredential ??
        (async () => ({ storage: "keyring" as const })),
      replace:
        options.replaceCredential !== undefined
          ? async (credential) =>
              (await options.replaceCredential?.(credential)) ?? {
                storage: "keyring" as const,
              }
          : async (credential) =>
              (await options.writeCredential?.(credential, {
                insecure: false,
              })) ?? { storage: "keyring" as const },
      delete: options.deleteCredential ?? (async () => {}),
    };
  }
  if (
    options.readConfig !== undefined ||
    options.writeConfig !== undefined ||
    options.deleteConfig !== undefined
  ) {
    return {
      read: async () => {
        const token = (await configStore.read()).token;
        return token === undefined
          ? null
          : { type: "personal_access_token", token };
      },
      write: async (credential) => {
        const token =
          credential.type === "personal_access_token"
            ? credential.token
            : credential.access_token;
        await configStore.write({ ...(await configStore.read()), token });
        return { storage: "keyring" as const };
      },
      replace: async (credential) => {
        const token =
          credential.type === "personal_access_token"
            ? credential.token
            : credential.access_token;
        await configStore.write({ ...(await configStore.read()), token });
        return { storage: "keyring" as const };
      },
      delete: () => configStore.delete(),
    };
  }
  return new CredentialStoreChain({
    keyring: createSystemKeyring(),
    plaintextPath: join(configDirectory, "credentials.json"),
  });
}
