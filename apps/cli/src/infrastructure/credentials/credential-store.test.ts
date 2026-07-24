import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CredentialStoreChain,
  createSystemKeyring,
  LazyKeyring,
} from "./credential-store.js";

const PAT = { type: "personal_access_token", token: "secret-pat" } as const;

describe("CredentialStoreChain", () => {
  it("uses the OS credential store by default", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "keyring",
    });
    await expect(store.read()).resolves.toEqual(PAT);
    expect(keyring.setPassword).toHaveBeenCalledWith(
      "barestash",
      "default",
      JSON.stringify(PAT),
    );
  });

  it.each([
    ["empty", ""],
    ["malformed JSON", "{"],
    ["an unsupported legacy format", JSON.stringify({ token: "legacy-pat" })],
  ])("falls back to the keyring when plaintext contains %s", async (_name, plaintext) => {
    const keyring = memoryKeyring();
    await keyring.setPassword("barestash", "default", JSON.stringify(PAT));
    const path = await temporaryCredentialPath();
    await writeFile(path, plaintext, "utf8");
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.read()).resolves.toEqual(PAT);
    expect(keyring.getPassword).toHaveBeenCalledWith("barestash", "default");
  });

  it("warns through its result and falls back to a 0600 plaintext file", async () => {
    const keyring = memoryKeyring();
    keyring.setPassword.mockRejectedValue(new Error("unavailable"));
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "plaintext",
      path,
      fallback: true,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(PAT)}\n`);
  });

  it("keeps the new plaintext authoritative when it cannot be removed after a keyring write", async () => {
    const keyring = memoryKeyring();
    const previous = {
      type: "personal_access_token",
      token: "previous-pat",
    } as const;
    const path = await temporaryCredentialPath();
    const initialStore = new CredentialStoreChain({
      keyring,
      plaintextPath: path,
    });
    await initialStore.write(previous, { insecure: true });
    const store = new CredentialStoreChain({
      keyring,
      plaintextPath: path,
      removePlaintext: async () => {
        throw new Error("plaintext is busy");
      },
    });

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "plaintext",
      path,
      fallback: true,
    });
    await expect(store.read()).resolves.toEqual(PAT);
    await expect(keyring.getPassword("barestash", "default")).resolves.toBe(
      JSON.stringify(PAT),
    );
  });

  it("does not mutate the keyring when the plaintext path cannot be read", async () => {
    const keyring = memoryKeyring();
    const previous = JSON.stringify({
      type: "personal_access_token",
      token: "previous-pat",
    });
    await keyring.setPassword("barestash", "default", previous);
    const path = await temporaryCredentialPath();
    await mkdir(path);
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.write(PAT, { insecure: false })).rejects.toThrow();
    await expect(keyring.getPassword("barestash", "default")).resolves.toBe(
      previous,
    );
  });

  it("does not treat invalid plaintext as authoritative when writing", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    await writeFile(path, "{", "utf8");
    const store = new CredentialStoreChain({
      keyring,
      plaintextPath: path,
      enforcePermissions: async () => {
        throw new Error("plaintext must not be written");
      },
    });

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "keyring",
    });
    await expect(keyring.getPassword("barestash", "default")).resolves.toBe(
      JSON.stringify(PAT),
    );
  });

  it("falls back to plaintext when the native keyring module cannot load", async () => {
    const loadKeyring = vi.fn(async () => {
      throw new Error("native keyring library unavailable");
    });
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({
      keyring: new LazyKeyring(loadKeyring),
      plaintextPath: path,
    });

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "plaintext",
      path,
      fallback: true,
    });
    expect(loadKeyring).toHaveBeenCalledOnce();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("loads keytar methods from its CommonJS default export", async () => {
    const keyring = createSystemKeyring();

    await expect(
      keyring.setPassword("barestash", "default", "credential"),
    ).resolves.toBeUndefined();
    await expect(keyring.deletePassword("barestash", "default")).resolves.toBe(
      true,
    );
  });

  it("removes plaintext secrets without exposing a stale keyring credential", async () => {
    const keyring = memoryKeyring();
    const stale = {
      type: "personal_access_token",
      token: "stale-keyring-pat",
    } as const;
    await keyring.setPassword("barestash", "default", JSON.stringify(stale));
    const path = await temporaryCredentialPath();
    await writeFile(path, JSON.stringify(PAT), "utf8");
    keyring.deletePassword.mockRejectedValueOnce(
      new Error("native keyring library unavailable"),
    );
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.delete()).resolves.toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain(PAT.token);
    await expect(store.read()).resolves.toBeNull();
    expect(keyring.getPassword).not.toHaveBeenCalled();

    await expect(store.write(PAT, { insecure: false })).resolves.toEqual({
      storage: "keyring",
    });
    await expect(store.read()).resolves.toEqual(PAT);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("masks plaintext credentials when removal fails after clearing the keyring", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    await writeFile(path, JSON.stringify(PAT), "utf8");
    const store = new CredentialStoreChain({
      keyring,
      plaintextPath: path,
      removePlaintext: async () => {
        throw new Error("plaintext is busy");
      },
    });

    await expect(store.delete()).resolves.toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain(PAT.token);
    await expect(store.read()).resolves.toBeNull();
    await expect(
      keyring.getPassword("barestash", "default"),
    ).resolves.toBeNull();
  });

  it("bypasses the keyring for explicit insecure storage", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });

    await expect(store.write(PAT, { insecure: true })).resolves.toEqual({
      storage: "plaintext",
      path,
      fallback: false,
    });
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("replaces plaintext credentials atomically without leaving a temp file", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });
    await store.write(PAT, { insecure: true });

    await store.write(
      { type: "personal_access_token", token: "replacement" },
      { insecure: true },
    );

    expect(await readFile(path, "utf8")).toContain("replacement");
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  it("falls back to plaintext when keyring replacement fails after server rotation", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });
    await store.write(PAT, { insecure: false });
    keyring.setPassword.mockRejectedValueOnce(new Error("keyring locked"));

    await expect(
      store.replace({ type: "personal_access_token", token: "rotated" }),
    ).resolves.toEqual({
      storage: "plaintext",
      path,
      fallback: true,
    });
    await expect(store.read()).resolves.toEqual({
      type: "personal_access_token",
      token: "rotated",
    });
  });

  it("replaces keyring credentials when plaintext is invalid", async () => {
    const keyring = memoryKeyring();
    const path = await temporaryCredentialPath();
    await writeFile(path, "{", "utf8");
    const store = new CredentialStoreChain({ keyring, plaintextPath: path });
    const rotated = {
      type: "personal_access_token",
      token: "rotated",
    } as const;

    await expect(store.replace(rotated)).resolves.toEqual({
      storage: "keyring",
    });
    await expect(keyring.getPassword("barestash", "default")).resolves.toBe(
      JSON.stringify(rotated),
    );
    await expect(readFile(path, "utf8")).resolves.toBe("{");
  });

  it("does not keep plaintext credentials when restrictive permissions fail", async () => {
    const keyring = memoryKeyring();
    keyring.setPassword.mockRejectedValue(new Error("unavailable"));
    const path = await temporaryCredentialPath();
    const store = new CredentialStoreChain({
      keyring,
      plaintextPath: path,
      platformName: "win32",
      enforcePermissions: async () => {
        throw new Error("ACL unavailable");
      },
    });

    await expect(store.write(PAT, { insecure: false })).rejects.toThrow(
      "ACL unavailable",
    );
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });
});

function memoryKeyring() {
  let value: string | null = null;
  return {
    getPassword: vi.fn(async (_service: string, _account: string) => value),
    setPassword: vi.fn(
      async (_service: string, _account: string, next: string) => {
        value = next;
      },
    ),
    deletePassword: vi.fn(async (_service: string, _account: string) => {
      value = null;
      return true;
    }),
  };
}

async function temporaryCredentialPath() {
  const directory = await mkdtemp(join(tmpdir(), "barestash-credentials-"));
  return join(directory, "credentials.json");
}
