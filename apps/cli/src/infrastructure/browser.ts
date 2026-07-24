import { spawn } from "node:child_process";

import type { BrowserOpener } from "../domain/ports.js";

/** @public */
export class SystemBrowserOpener implements BrowserOpener {
  readonly #platform: NodeJS.Platform;
  readonly #openOverride?: (url: string) => Promise<boolean>;

  constructor(
    platform: NodeJS.Platform,
    openOverride?: (url: string) => Promise<boolean>,
  ) {
    this.#platform = platform;
    this.#openOverride = openOverride;
  }

  async open(url: string): Promise<boolean> {
    if (this.#openOverride !== undefined) return this.#openOverride(url);
    const command =
      this.#platform === "darwin"
        ? { file: "open", args: [url] }
        : this.#platform === "win32"
          ? {
              file: "rundll32.exe",
              args: ["url.dll,FileProtocolHandler", url],
            }
          : { file: "xdg-open", args: [url] };
    try {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}
