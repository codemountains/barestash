import type { RequestBodyStore } from "../../domain/ports.js";

/** @public */
export class InMemoryRequestBodyStore implements RequestBodyStore {
  readonly #objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.#objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.#objects.delete(key);
    }
  }
}
