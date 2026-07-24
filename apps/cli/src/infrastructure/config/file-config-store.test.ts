import { access, chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileConfigStore } from "./file-config-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

async function temporaryStore(): Promise<{
  configPath: string;
  store: FileConfigStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "barestash-config-test-"));
  const configPath = join(directory, "nested", "config.json");
  temporaryDirectories.push(directory);

  return {
    configPath,
    store: new FileConfigStore({
      env: {
        BARESTASH_CONFIG_FILE: configPath,
      },
      platformName: process.platform,
      homeDirectory: directory,
    }),
  };
}

describe("FileConfigStore", () => {
  it("reads an absent config as empty", async () => {
    const { store } = await temporaryStore();

    await expect(store.read()).resolves.toEqual({});
  });

  it("creates parent directories, writes config, and reads it back", async () => {
    const { configPath, store } = await temporaryStore();
    const config = {
      token: "test-token",
      default_endpoint: "ep_test",
    };

    await store.write(config);

    await expect(store.read()).resolves.toEqual(config);
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      `${JSON.stringify(config, null, 2)}\n`,
    );
  });

  it("restricts the config file to the current user on POSIX platforms", async () => {
    const { configPath, store } = await temporaryStore();

    await store.write({ token: "test-token" });

    if (process.platform !== "win32") {
      await chmod(configPath, 0o644);
      await store.write({ token: "updated-test-token" });

      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("deletes the config file and tolerates repeated deletion", async () => {
    const { configPath, store } = await temporaryStore();
    await store.write({ token: "test-token" });

    await store.delete();
    await store.delete();

    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.read()).resolves.toEqual({});
  });
});
