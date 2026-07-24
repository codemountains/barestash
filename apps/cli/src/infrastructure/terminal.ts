import { createInterface } from "node:readline/promises";

import type { Confirmer, Sleeper, StdinReader } from "../domain/ports.js";

/** @public */
export class ProcessStdinReader implements StdinReader {
  readonly #readStdin?: () => Promise<string>;

  constructor(readStdin?: () => Promise<string>) {
    this.#readStdin = readStdin;
  }

  async read(): Promise<string> {
    if (this.#readStdin !== undefined) {
      return this.#readStdin();
    }

    const chunks: Buffer[] = [];

    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
  }
}

/** @public */
export class ReadlineConfirmer implements Confirmer {
  readonly #confirm?: (message: string) => Promise<boolean>;

  constructor(confirm?: (message: string) => Promise<boolean>) {
    this.#confirm = confirm;
  }

  async confirm(message: string): Promise<boolean> {
    if (this.#confirm !== undefined) {
      return this.#confirm(message);
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const answer = await rl.question(`${message} Type yes to continue: `);

      return answer.trim().toLowerCase() === "yes";
    } finally {
      rl.close();
    }
  }
}

/** @public */
export class TimerSleeper implements Sleeper {
  readonly #sleep?: (milliseconds: number) => Promise<void>;
  readonly #signal?: AbortSignal;

  constructor(
    sleep?: (milliseconds: number) => Promise<void>,
    signal?: AbortSignal,
  ) {
    this.#sleep = sleep;
    this.#signal = signal;
  }

  async sleep(milliseconds: number): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw this.#signal.reason;
    }

    if (this.#sleep !== undefined) {
      await this.waitForSleep(this.#sleep(milliseconds));
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => {
        clearTimeout(timeout);
        reject(this.#signal?.reason);
      };
      const timeout = setTimeout(() => {
        this.#signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, milliseconds);

      this.#signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  private async waitForSleep(sleep: Promise<void>): Promise<void> {
    if (this.#signal === undefined) {
      await sleep;
      return;
    }

    const signal = this.#signal;
    let handleAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      handleAbort = () => reject(signal.reason);
      signal.addEventListener("abort", handleAbort, { once: true });
    });

    try {
      await Promise.race([sleep, interrupted]);
    } finally {
      if (handleAbort !== undefined) {
        signal.removeEventListener("abort", handleAbort);
      }
    }
  }
}
