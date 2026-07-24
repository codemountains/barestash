import type {
  CleanupRequestBodyStore,
  RequestBodyObjectList,
  RequestBodyStore,
} from "../../domain/ports.js";

/** @public */
export class R2RequestBodyStore implements CleanupRequestBodyStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    await this.#bucket.put(key, value);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(key);

    if (object === null) {
      return null;
    }

    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.#bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    await this.#bucket.delete(keys);
  }

  async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }): Promise<RequestBodyObjectList> {
    const result = await this.#bucket.list(options);
    const objects = result.objects.map((object) => ({
      key: object.key,
      uploaded: object.uploaded,
    }));

    if (result.truncated) {
      return {
        objects,
        truncated: true,
        cursor: result.cursor,
      };
    }

    return {
      objects,
      truncated: false,
    };
  }
}

/** @public */
export class MissingRequestBodyStore implements RequestBodyStore {
  async put(): Promise<void> {
    throw new Error("REQUEST_BODIES R2 binding is not configured.");
  }

  async get(): Promise<Uint8Array | null> {
    throw new Error("REQUEST_BODIES R2 binding is not configured.");
  }

  async delete(_key: string): Promise<void> {
    throw new Error("REQUEST_BODIES R2 binding is not configured.");
  }

  async deleteMany(_keys: string[]): Promise<void> {
    throw new Error("REQUEST_BODIES R2 binding is not configured.");
  }
}
