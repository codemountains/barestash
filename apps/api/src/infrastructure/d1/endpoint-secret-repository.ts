import type { EndpointId, SecretId } from "@barestash/shared/ids";
import {
  type CreateEndpointSecretInput,
  type EndpointSecretRow,
  endpointSecretRowToStoredSecret,
  type StoredEndpointSecret,
} from "../../domain/endpoint-secret.js";
import type { EndpointSecretRepository } from "../../domain/ports.js";

/** @public */
export class D1EndpointSecretRepository implements EndpointSecretRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async createEndpointSecret(
    input: CreateEndpointSecretInput,
  ): Promise<StoredEndpointSecret> {
    const createdAt = input.now.toISOString();

    await this.#db
      .prepare(
        `INSERT INTO endpoint_secrets (
          id,
          endpoint_id,
          secret_hash,
          status,
          created_at,
          last_used_at,
          revoked_at
        ) VALUES (?, ?, ?, 'active', ?, NULL, NULL)`,
      )
      .bind(input.id, input.endpointId, input.secretHash, createdAt)
      .run();

    return {
      id: input.id,
      endpoint_id: input.endpointId,
      secret_hash: input.secretHash,
      status: "active",
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    };
  }

  async listEndpointSecrets(
    endpointId: EndpointId,
  ): Promise<StoredEndpointSecret[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoint_secrets
         WHERE endpoint_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(endpointId)
      .all<EndpointSecretRow>();

    return result.results.map(endpointSecretRowToStoredSecret);
  }

  async listActiveEndpointSecrets(
    endpointId: EndpointId,
  ): Promise<StoredEndpointSecret[]> {
    const result = await this.#db
      .prepare(
        `SELECT *
         FROM endpoint_secrets
         WHERE endpoint_id = ?
           AND status = 'active'
         ORDER BY created_at DESC`,
      )
      .bind(endpointId)
      .all<EndpointSecretRow>();

    return result.results.map(endpointSecretRowToStoredSecret);
  }

  async updateEndpointSecretLastUsed(
    id: SecretId,
    lastUsedAt: string,
  ): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE endpoint_secrets
         SET last_used_at = ?
         WHERE id = ?
           AND status = 'active'`,
      )
      .bind(lastUsedAt, id)
      .run();
  }

  async revokeEndpointSecret(
    endpointId: EndpointId,
    id: SecretId,
    revokedAt: string,
  ): Promise<StoredEndpointSecret | null> {
    await this.#db
      .prepare(
        `UPDATE endpoint_secrets
         SET status = 'revoked', revoked_at = ?
         WHERE endpoint_id = ?
           AND id = ?`,
      )
      .bind(revokedAt, endpointId, id)
      .run();

    const row = await this.#db
      .prepare(
        "SELECT * FROM endpoint_secrets WHERE endpoint_id = ? AND id = ?",
      )
      .bind(endpointId, id)
      .first<EndpointSecretRow>();

    return row === null ? null : endpointSecretRowToStoredSecret(row);
  }

  async deleteEndpointSecrets(endpointId: EndpointId): Promise<void> {
    await this.#db
      .prepare("DELETE FROM endpoint_secrets WHERE endpoint_id = ?")
      .bind(endpointId)
      .run();
  }
}
