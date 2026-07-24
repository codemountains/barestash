import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { CredentialLock } from "../../domain/ports.js";

/** @public */
export class FileCredentialLock implements CredentialLock {
  readonly #path: string;
  readonly #retryMilliseconds: number;
  readonly #timeoutMilliseconds: number;
  readonly #staleMilliseconds: number;

  constructor(options: {
    path: string;
    retryMilliseconds?: number;
    timeoutMilliseconds?: number;
    staleMilliseconds?: number;
  }) {
    this.#path = options.path;
    this.#retryMilliseconds = options.retryMilliseconds ?? 50;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.#staleMilliseconds = options.staleMilliseconds ?? 30_000;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(this.#path, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
          return await operation();
        } finally {
          await handle.close();
          await rm(this.#path, { force: true });
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.#removeIfStale();
        if (Date.now() - startedAt >= this.#timeoutMilliseconds) {
          throw new Error("Timed out waiting for the credential lock.");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.#retryMilliseconds),
        );
      }
    }
  }

  async #removeIfStale(): Promise<void> {
    try {
      const ownerPid = Number.parseInt(await readFile(this.#path, "utf8"), 10);
      if (Number.isInteger(ownerPid) && processIsRunning(ownerPid)) return;
      const details = await stat(this.#path);
      if (Date.now() - details.mtimeMs > this.#staleMilliseconds) {
        await rm(this.#path, { force: true });
      }
    } catch {
      // Another process may have released the lock between checks.
    }
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
