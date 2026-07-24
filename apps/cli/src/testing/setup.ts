import { vi } from "vitest";

vi.mock("@github/keytar", () => {
  const keytar = {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => {}),
    deletePassword: vi.fn(async () => true),
  };
  return {
    default: keytar,
    getPassword: keytar.getPassword,
    "module.exports": keytar,
  };
});

vi.mock("../infrastructure/credentials/file-lock.js", () => ({
  FileCredentialLock: class {
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    }
  },
}));
