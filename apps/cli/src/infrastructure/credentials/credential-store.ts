import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import {
  parseStoredCredential,
  type StoredCredential,
} from "../../domain/credential.js";
import type {
  CredentialStore,
  CredentialWriteResult,
} from "../../domain/ports.js";

const SERVICE = "barestash";
const ACCOUNT = "default";
const LOGGED_OUT_MARKER = JSON.stringify({ version: 1, state: "logged_out" });
const execFileAsync = promisify(execFile);

export type Keyring = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

type KeyringLoader = () => Promise<Keyring>;

export class LazyKeyring implements Keyring {
  readonly #load: KeyringLoader;
  #keyring: Promise<Keyring> | undefined;

  constructor(load: KeyringLoader) {
    this.#load = load;
  }

  getPassword(service: string, account: string): Promise<string | null> {
    return this.#getKeyring().then((keyring) =>
      keyring.getPassword(service, account),
    );
  }

  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void> {
    return this.#getKeyring().then((keyring) =>
      keyring.setPassword(service, account, password),
    );
  }

  deletePassword(service: string, account: string): Promise<boolean> {
    return this.#getKeyring().then((keyring) =>
      keyring.deletePassword(service, account),
    );
  }

  #getKeyring(): Promise<Keyring> {
    this.#keyring ??= this.#load();
    return this.#keyring;
  }
}

/** @public */
export function createSystemKeyring(): Keyring {
  return new LazyKeyring(async () => {
    const moduleNamespace: unknown = await import("@github/keytar");
    if (
      typeof moduleNamespace === "object" &&
      moduleNamespace !== null &&
      "default" in moduleNamespace &&
      isKeyring(moduleNamespace.default)
    ) {
      return moduleNamespace.default;
    }
    if (isKeyring(moduleNamespace)) return moduleNamespace;
    throw new TypeError("The native keyring module has an unsupported shape.");
  });
}

function isKeyring(value: unknown): value is Keyring {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getPassword === "function" &&
    typeof candidate.setPassword === "function" &&
    typeof candidate.deletePassword === "function"
  );
}

/** @public */
export class CredentialStoreChain implements CredentialStore {
  readonly #keyring: Keyring;
  readonly #plaintextPath: string;
  readonly #enforcePermissions: (path: string) => Promise<void>;
  readonly #removePlaintext: () => Promise<void>;

  constructor(options: {
    keyring: Keyring;
    plaintextPath: string;
    platformName?: NodeJS.Platform;
    enforcePermissions?: (path: string) => Promise<void>;
    removePlaintext?: () => Promise<void>;
  }) {
    this.#keyring = options.keyring;
    this.#plaintextPath = options.plaintextPath;
    this.#enforcePermissions =
      options.enforcePermissions ??
      ((path) =>
        enforceFilePermissions(path, options.platformName ?? process.platform));
    this.#removePlaintext =
      options.removePlaintext ??
      (() => rm(this.#plaintextPath, { force: true }));
  }

  async read(): Promise<StoredCredential | null> {
    const plaintext = await readOptionalFile(this.#plaintextPath);
    if (isLoggedOutMarker(plaintext)) return null;
    if (plaintext !== null) {
      const credential = parseStoredCredential(plaintext);
      if (credential !== null) return credential;
    }
    try {
      return parseStoredCredential(
        await this.#keyring.getPassword(SERVICE, ACCOUNT),
      );
    } catch {
      return null;
    }
  }

  async write(
    credential: StoredCredential,
    options: { insecure: boolean },
  ): Promise<CredentialWriteResult> {
    const serialized = JSON.stringify(credential);
    if (!options.insecure) {
      const plaintext = await readOptionalFile(this.#plaintextPath);
      const plaintextMustMaskKeyring =
        parseStoredCredential(plaintext) !== null ||
        isLoggedOutMarker(plaintext);
      if (plaintextMustMaskKeyring) {
        await this.#writePlaintext(serialized);
      }
      try {
        await this.#keyring.setPassword(SERVICE, ACCOUNT, serialized);
      } catch {
        if (!plaintextMustMaskKeyring) {
          await this.#writePlaintext(serialized);
        }
        return {
          storage: "plaintext",
          path: this.#plaintextPath,
          fallback: true,
        };
      }
      if (plaintextMustMaskKeyring) {
        try {
          await this.#removePlaintext();
        } catch {
          return {
            storage: "plaintext",
            path: this.#plaintextPath,
            fallback: true,
          };
        }
      }
      return { storage: "keyring" };
    }

    await this.#writePlaintext(serialized);
    try {
      await this.#keyring.deletePassword(SERVICE, ACCOUNT);
    } catch {
      // The plaintext file is authoritative when it exists.
    }
    return {
      storage: "plaintext",
      path: this.#plaintextPath,
      fallback: false,
    };
  }

  async delete(): Promise<void> {
    try {
      await this.#keyring.deletePassword(SERVICE, ACCOUNT);
    } catch {
      await this.#writePlaintext(LOGGED_OUT_MARKER);
      return;
    }
    try {
      await this.#removePlaintext();
    } catch {
      await this.#writePlaintext(LOGGED_OUT_MARKER);
    }
  }

  async replace(credential: StoredCredential): Promise<CredentialWriteResult> {
    const plaintext = await readOptionalFile(this.#plaintextPath);
    if (
      parseStoredCredential(plaintext) !== null ||
      isLoggedOutMarker(plaintext)
    ) {
      await this.#writePlaintext(JSON.stringify(credential));
      return {
        storage: "plaintext",
        path: this.#plaintextPath,
        fallback: false,
      };
    }
    try {
      await this.#keyring.setPassword(
        SERVICE,
        ACCOUNT,
        JSON.stringify(credential),
      );
      return { storage: "keyring" };
    } catch {
      await this.#writePlaintext(JSON.stringify(credential));
      return {
        storage: "plaintext",
        path: this.#plaintextPath,
        fallback: true,
      };
    }
  }

  async #writePlaintext(serialized: string): Promise<void> {
    const temporaryPath = `${this.#plaintextPath}.tmp`;
    await mkdir(dirname(this.#plaintextPath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${serialized}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.#enforcePermissions(temporaryPath);
      await rename(temporaryPath, this.#plaintextPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

async function enforceFilePermissions(
  path: string,
  platformName: NodeJS.Platform,
): Promise<void> {
  if (platformName !== "win32") {
    await chmod(path, 0o600);
    return;
  }
  const username = process.env.USERNAME;
  if (username === undefined || username.length === 0) {
    throw new Error(
      "Unable to determine the Windows user for credential ACLs.",
    );
  }
  await execFileAsync("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${username}:F`,
  ]);
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isLoggedOutMarker(value: string | null): boolean {
  if (value === null) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1 &&
      "state" in parsed &&
      parsed.state === "logged_out"
    );
  } catch {
    return false;
  }
}
