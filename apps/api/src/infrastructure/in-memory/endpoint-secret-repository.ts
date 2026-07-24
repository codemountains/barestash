import type { EndpointId, SecretId } from "@barestash/shared/ids";

import type {
  CreateEndpointSecretInput,
  StoredEndpointSecret,
} from "../../domain/endpoint-secret.js";
import type { EndpointSecretRepository } from "../../domain/ports.js";

/** @public */
export class InMemoryEndpointSecretRepository
  implements EndpointSecretRepository
{
  readonly #secrets = new Map<SecretId, StoredEndpointSecret>();

  async createEndpointSecret(
    input: CreateEndpointSecretInput,
  ): Promise<StoredEndpointSecret> {
    const createdAt = input.now.toISOString();
    const secret = {
      id: input.id,
      endpoint_id: input.endpointId,
      secret_hash: input.secretHash,
      status: "active",
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    } satisfies StoredEndpointSecret;

    this.#secrets.set(secret.id, secret);

    return secret;
  }

  async listEndpointSecrets(
    endpointId: EndpointId,
  ): Promise<StoredEndpointSecret[]> {
    return Array.from(this.#secrets.values())
      .filter((secret) => secret.endpoint_id === endpointId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async listActiveEndpointSecrets(
    endpointId: EndpointId,
  ): Promise<StoredEndpointSecret[]> {
    return (await this.listEndpointSecrets(endpointId)).filter(
      (secret) => secret.status === "active",
    );
  }

  async updateEndpointSecretLastUsed(
    id: SecretId,
    lastUsedAt: string,
  ): Promise<void> {
    const secret = this.#secrets.get(id);

    if (secret === undefined || secret.status !== "active") {
      return;
    }

    this.#secrets.set(id, {
      ...secret,
      last_used_at: lastUsedAt,
    });
  }

  async revokeEndpointSecret(
    endpointId: EndpointId,
    id: SecretId,
    revokedAt: string,
  ): Promise<StoredEndpointSecret | null> {
    const secret = this.#secrets.get(id);

    if (secret === undefined || secret.endpoint_id !== endpointId) {
      return null;
    }

    const revoked = {
      ...secret,
      status: "revoked" as const,
      revoked_at: revokedAt,
    };
    this.#secrets.set(id, revoked);

    return revoked;
  }

  async deleteEndpointSecrets(endpointId: EndpointId): Promise<void> {
    for (const secret of this.#secrets.values()) {
      if (secret.endpoint_id === endpointId) {
        this.#secrets.delete(secret.id);
      }
    }
  }
}
