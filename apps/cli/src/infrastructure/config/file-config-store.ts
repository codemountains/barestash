import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type CliConfig,
  parseConfig,
  resolveConfigPath,
  serializeConfig,
} from "../../domain/config.js";
import type { ConfigStore } from "../../domain/ports.js";

export type FileConfigStoreOptions = {
  env: Record<string, string | undefined>;
  platformName: string;
  homeDirectory: string;
  readConfig?: (path: string) => Promise<string | null>;
  writeConfig?: (path: string, value: string) => Promise<void>;
  deleteConfig?: (path: string) => Promise<void>;
};

/** @public */
export class FileConfigStore implements ConfigStore {
  readonly #options: FileConfigStoreOptions;

  constructor(options: FileConfigStoreOptions) {
    this.#options = options;
  }

  path(): string {
    return resolveConfigPath(
      this.#options.env,
      this.#options.platformName,
      this.#options.homeDirectory,
    );
  }

  async read(): Promise<CliConfig> {
    const path = this.path();
    let text: string | null;

    if (this.#options.readConfig !== undefined) {
      text = await this.#options.readConfig(path);
    } else {
      try {
        text = await readFile(path, "utf8");
      } catch {
        text = null;
      }
    }

    return parseConfig(text);
  }

  async write(config: CliConfig): Promise<void> {
    const path = this.path();
    const text = serializeConfig(config);

    if (this.#options.writeConfig !== undefined) {
      await this.#options.writeConfig(path, text);
      return;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  async delete(): Promise<void> {
    const path = this.path();

    if (this.#options.deleteConfig !== undefined) {
      await this.#options.deleteConfig(path);
      return;
    }

    await rm(path, { force: true });
  }
}
