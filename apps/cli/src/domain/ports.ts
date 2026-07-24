import type { CliConfig } from "./config.js";
import type { StoredCredential } from "./credential.js";

/** @public */
export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

/** @public */
export type CliFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** @public */
export type ConfigStore = {
  read: () => Promise<CliConfig>;
  write: (config: CliConfig) => Promise<void>;
  delete: () => Promise<void>;
};

/** @public */
export type CredentialWriteResult =
  | { storage: "keyring" }
  | { storage: "plaintext"; path: string; fallback: boolean };

/** @public */
export type CredentialStore = {
  read: () => Promise<StoredCredential | null>;
  write: (
    credential: StoredCredential,
    options: { insecure: boolean },
  ) => Promise<CredentialWriteResult>;
  replace: (credential: StoredCredential) => Promise<CredentialWriteResult>;
  delete: () => Promise<void>;
};

/** @public */
export type BrowserOpener = {
  open: (url: string) => Promise<boolean>;
};

/** @public */
export type CredentialLock = {
  withLock: <T>(operation: () => Promise<T>) => Promise<T>;
};

/** @public */
export type StdinReader = {
  read: () => Promise<string>;
};

/** @public */
export type Confirmer = {
  confirm: (message: string) => Promise<boolean>;
};

/** @public */
export type Sleeper = {
  sleep: (milliseconds: number) => Promise<void>;
};
