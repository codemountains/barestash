/// <reference types="node" />

import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  StoredAccessToken,
  StoredCliSession,
  StoredDeviceAuthorization,
  StoredRefreshToken,
} from "../../domain/auth-domain.js";
import { D1AuthDomainRepository } from "./auth-domain-repository.js";

const AUTH_SCHEMA = readFileSync(
  new URL(
    "../../../migrations/0003_auth_domain_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("D1AuthDomainRepository", () => {
  it.each([
    [1, "created"],
    [0, "user_code_conflict"],
  ] as const)("reports Device Authorization insert changes as %s -> %s", async (changes, expected) => {
    const db = new CreationD1Database(changes);
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.createDeviceAuthorization(deviceAuthorization()),
    ).resolves.toBe(expected);
    expect(db.query).toContain("ON CONFLICT(user_code_hash) DO NOTHING");
  });

  it("uses the consume CAS as the gate for Device Authorization exchange", async () => {
    const db = new ExchangeD1Database([1, 1, 1, 1]);
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.exchangeDeviceAuthorization(
        "dva_test",
        session(),
        accessToken(),
        refreshToken(),
        "2026-07-13T00:05:00.000Z",
      ),
    ).resolves.toBe("exchanged");

    expect(db.batchQueries[0]).toContain("UPDATE device_authorizations");
    expect(db.batchQueries[0]).toContain("status = 'approved'");
    expect(db.batchQueries[0]).toContain("expires_at > ?");
    expect(db.batchQueries[0]).toContain("accounts.status = 'active'");
    expect(db.batchQueries[1]).toContain("WHERE changes() = 1");
    expect(db.batchQueries[2]).toContain("WHERE changes() = 1");
    expect(db.batchQueries[3]).toContain("WHERE changes() = 1");
  });

  it("returns unavailable when another exchange wins the consume CAS", async () => {
    const db = new ExchangeD1Database([0, 0, 0, 0]);
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.exchangeDeviceAuthorization(
        "dva_test",
        session(),
        accessToken(),
        refreshToken(),
        "2026-07-13T00:05:00.000Z",
      ),
    ).resolves.toBe("authorization_unavailable");

    expect(db.batchQueries.slice(1, 4)).toHaveLength(3);
    for (const query of db.batchQueries.slice(1, 4)) {
      expect(query).toContain("WHERE changes() = 1");
    }
    expect(db.batchQueries[4]).toContain("SELECT");
  });

  it("classifies a disabled account from the exchange batch snapshot", async () => {
    const db = new ExchangeD1Database([0, 0, 0, 0], {
      authorization_status: "approved",
      account_id: "acc_test",
      expires_at: "2026-07-13T00:10:00.000Z",
      account_status: "disabled",
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.exchangeDeviceAuthorization(
        "dva_test",
        session(),
        accessToken(),
        refreshToken(),
        "2026-07-13T00:05:00.000Z",
      ),
    ).resolves.toBe("account_disabled");

    expect(db.batchQueries[4]).toContain("SELECT");
    expect(db.batchQueries[4]).toContain("account_status");
  });

  it("uses a guarded mutation chain for atomic session rotation", async () => {
    const db = new SessionLifecycleD1Database({
      rotationChanges: [1, 1, 1, 1, 0],
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.rotateRefreshToken(
        refreshToken().id,
        accessToken(),
        { ...refreshToken(), id: "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" },
        "2026-07-14T00:00:00.000Z",
        "2026-08-13T00:00:00.000Z",
      ),
    ).resolves.toBe("rotated");

    expect(db.batchQueries).toHaveLength(5);
    expect(db.batchQueries[0]).toContain("INSERT INTO access_tokens");
    expect(db.batchQueries[0]).toContain("cli_sessions.idle_expires_at > ?");
    expect(db.batchQueries[0]).toContain("accounts.status = 'active'");
    for (const query of db.batchQueries.slice(1, 4)) {
      expect(query).toContain("changes() = 1");
    }
    expect(db.batchQueries[2]).toContain("UPDATE refresh_tokens");
    expect(db.batchQueries[2]).toContain("status = 'active'");
    expect(db.batchQueries[4]).toContain("changes() <> 1");
    expect(db.batchQueries[4]).toContain("INSERT INTO access_tokens");
  });

  it("does not report an incomplete refresh rotation as successful", async () => {
    const db = new SessionLifecycleD1Database({
      rotationChanges: [1, 1, 0, 0, 0],
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.rotateRefreshToken(
        refreshToken().id,
        accessToken(),
        { ...refreshToken(), id: "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" },
        "2026-07-14T00:00:00.000Z",
        "2026-08-13T00:00:00.000Z",
      ),
    ).rejects.toThrow("D1_ERROR: incomplete refresh rotation");
  });

  it("rolls back every refresh mutation when a guarded update affects no rows", async () => {
    const db = new TransactionalRotationSqliteDatabase();
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);
    const before = db.snapshot();
    db.ignoreRefreshConsume();

    try {
      await expect(
        repository.rotateRefreshToken(
          refreshToken().id,
          accessToken(),
          {
            ...refreshToken(),
            id: "rtk_ABCDEFGHIJKLMNOPQRSTUVWX",
            token_hash: "next-refresh-hash",
            parent_token_id: refreshToken().id,
          },
          "2026-07-14T00:00:00.000Z",
          "2026-08-13T00:00:00.000Z",
        ),
      ).rejects.toThrow(/NOT NULL constraint failed/);

      expect(db.snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("revokes the token family when refresh reuse wins the CAS race", async () => {
    const db = new SessionLifecycleD1Database({
      rotationChanges: [0, 0, 0, 0, 0],
      refresh: { ...refreshToken(), status: "used" },
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.rotateRefreshToken(
        refreshToken().id,
        accessToken(),
        { ...refreshToken(), id: "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" },
        "2026-07-14T00:00:00.000Z",
        "2026-08-13T00:00:00.000Z",
      ),
    ).resolves.toBe("reuse_detected");

    expect(db.batchQueries).toHaveLength(8);
    expect(db.batchQueries[5]).toContain("status = 'compromised'");
    expect(db.batchQueries[6]).toContain("UPDATE access_tokens");
    expect(db.batchQueries[7]).toContain("WHERE token_family_id = ?");
  });

  it.each([
    [
      "expired session",
      {
        session: { ...session(), idle_expires_at: "2026-07-13T23:59:59.000Z" },
      },
      "session_expired",
    ],
    ["disabled account", { accountStatus: "disabled" }, "account_disabled"],
  ] as const)("classifies an active refresh token with %s", async (_name, options, expected) => {
    const db = new SessionLifecycleD1Database({
      rotationChanges: [0, 0, 0, 0, 0],
      ...options,
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.rotateRefreshToken(
        refreshToken().id,
        accessToken(),
        { ...refreshToken(), id: "rtk_ABCDEFGHIJKLMNOPQRSTUVWX" },
        "2026-07-14T00:00:00.000Z",
        "2026-08-13T00:00:00.000Z",
      ),
    ).resolves.toBe(expected);
  });

  it("revokes a CLI session and every token issued for it", async () => {
    const db = new SessionLifecycleD1Database({
      rotationChanges: [0, 0, 0, 0, 0],
    });
    const repository = new D1AuthDomainRepository(db as unknown as D1Database);

    await expect(
      repository.revokeCliSession(session().id, "2026-07-14T00:00:00.000Z"),
    ).resolves.toMatchObject({ id: session().id });

    expect(db.batchQueries).toHaveLength(3);
    expect(db.batchQueries[0]).toContain("UPDATE cli_sessions");
    expect(db.batchQueries[1]).toContain("UPDATE access_tokens");
    expect(db.batchQueries[2]).toContain("UPDATE refresh_tokens");
    expect(db.batchQueries[1]).toContain("status <> 'revoked'");
    expect(db.batchQueries[2]).toContain("status <> 'revoked'");
  });
});

class CreationD1Database {
  query = "";

  constructor(private readonly changes: number) {}

  prepare(query: string) {
    this.query = query;
    return {
      bind: (..._bindings: unknown[]) => ({
        run: async () => ({ meta: { changes: this.changes } }),
      }),
    };
  }
}

class ExchangeD1Database {
  readonly batchQueries: string[] = [];

  constructor(
    private readonly changes: number[],
    private readonly exchangeState = {
      authorization_status: "consumed",
      account_id: "acc_test",
      expires_at: "2026-07-13T00:10:00.000Z",
      account_status: "active",
    },
  ) {}

  prepare(query: string) {
    return {
      bind: (..._bindings: unknown[]) => ({
        query,
        first: async () =>
          query.includes("FROM accounts")
            ? { status: "active" }
            : {
                ...deviceAuthorization(),
                status: this.exchangeState.authorization_status,
                requested_scopes_json: JSON.stringify(
                  deviceAuthorization().requested_scopes,
                ),
              },
      }),
    };
  }

  async batch(statements: { query: string }[]) {
    this.batchQueries.push(...statements.map(({ query }) => query));
    return statements.map((_, index) =>
      index === 4
        ? { meta: { changes: 0 }, results: [this.exchangeState] }
        : { meta: { changes: this.changes[index] ?? 0 } },
    );
  }
}

type SqliteD1Statement = {
  query: string;
  bindings: SQLInputValue[];
};

class TransactionalRotationSqliteDatabase {
  readonly #db = new DatabaseSync(":memory:");

  constructor() {
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(AUTH_SCHEMA);
    this.#db
      .prepare(`INSERT INTO accounts (
        id, primary_email, display_name, avatar_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "acc_test",
        "user@example.com",
        null,
        null,
        "active",
        "2026-07-13T00:00:00.000Z",
        "2026-07-13T00:00:00.000Z",
      );
    this.#db
      .prepare(`INSERT INTO cli_sessions (
        id, account_id, device_name, client_version, status, scopes_json,
        created_at, last_used_at, idle_expires_at, absolute_expires_at,
        revoked_at, compromised_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        session().id,
        session().account_id,
        session().device_name,
        session().client_version,
        session().status,
        JSON.stringify(session().scopes),
        session().created_at,
        session().last_used_at,
        session().idle_expires_at,
        session().absolute_expires_at,
        session().revoked_at,
        session().compromised_at,
      );
    this.#db
      .prepare(`INSERT INTO refresh_tokens (
        id, session_id, token_hash, token_family_id, status, parent_token_id,
        replaced_by_token_id, created_at, expires_at, used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        refreshToken().id,
        refreshToken().session_id,
        refreshToken().token_hash,
        refreshToken().token_family_id,
        refreshToken().status,
        refreshToken().parent_token_id,
        refreshToken().replaced_by_token_id,
        refreshToken().created_at,
        refreshToken().expires_at,
        refreshToken().used_at,
        refreshToken().revoked_at,
      );
  }

  prepare(query: string) {
    return {
      bind: (...bindings: SQLInputValue[]): SqliteD1Statement => ({
        query,
        bindings,
      }),
    };
  }

  async batch(statements: SqliteD1Statement[]) {
    this.#db.exec("BEGIN");
    try {
      const results = statements.map(({ query, bindings }) => ({
        meta: {
          changes: Number(this.#db.prepare(query).run(...bindings).changes),
        },
      }));
      this.#db.exec("COMMIT");
      return results;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`D1_ERROR: ${message}`, { cause: error });
    }
  }

  ignoreRefreshConsume() {
    this.#db.exec(`CREATE TRIGGER ignore_refresh_consume
      BEFORE UPDATE OF status ON refresh_tokens
      WHEN OLD.status = 'active' AND NEW.status = 'used'
      BEGIN
        SELECT RAISE(IGNORE);
      END`);
  }

  snapshot() {
    return {
      accessTokens: this.#db.prepare("SELECT * FROM access_tokens").all(),
      refreshTokens: this.#db.prepare("SELECT * FROM refresh_tokens").all(),
      sessions: this.#db.prepare("SELECT * FROM cli_sessions").all(),
    };
  }

  close() {
    this.#db.close();
  }
}

class SessionLifecycleD1Database {
  readonly batchQueries: string[] = [];
  readonly #rotationChanges: number[];
  readonly #refresh: StoredRefreshToken;
  readonly #session: StoredCliSession;
  readonly #accountStatus: string;

  constructor(options: {
    rotationChanges: number[];
    refresh?: StoredRefreshToken;
    session?: StoredCliSession;
    accountStatus?: string;
  }) {
    this.#rotationChanges = options.rotationChanges;
    this.#refresh = options.refresh ?? refreshToken();
    this.#session = options.session ?? session();
    this.#accountStatus = options.accountStatus ?? "active";
  }

  prepare(query: string) {
    return {
      bind: (..._bindings: unknown[]) => ({
        query,
        first: async () => {
          if (query.includes("FROM refresh_tokens")) return this.#refresh;
          if (query.includes("FROM cli_sessions")) {
            return {
              ...this.#session,
              scopes_json: JSON.stringify(this.#session.scopes),
            };
          }
          if (query.includes("FROM accounts")) {
            return {
              id: "acc_test",
              primary_email: "user@example.com",
              display_name: null,
              avatar_url: null,
              status: this.#accountStatus,
              created_at: "2026-07-13T00:00:00.000Z",
              updated_at: "2026-07-13T00:00:00.000Z",
            };
          }
          return null;
        },
      }),
    };
  }

  async batch(statements: { query: string }[]) {
    this.batchQueries.push(...statements.map(({ query }) => query));
    if (
      statements[4]?.query.includes("changes() <> 1") &&
      this.#rotationChanges.slice(0, 4).some((changes) => changes === 1) &&
      this.#rotationChanges.slice(0, 4).some((changes) => changes !== 1)
    ) {
      throw new Error("D1_ERROR: incomplete refresh rotation");
    }
    return statements.map((_, index) => ({
      meta: { changes: this.#rotationChanges[index] ?? 0 },
    }));
  }
}

function session(): StoredCliSession {
  return {
    id: "cls_test",
    account_id: "acc_test",
    device_name: "test-device",
    client_version: "0.1.0",
    status: "active",
    scopes: ["events:read"],
    created_at: "2026-07-13T00:05:00.000Z",
    last_used_at: null,
    idle_expires_at: "2026-08-12T00:00:00.000Z",
    absolute_expires_at: "2026-10-11T00:00:00.000Z",
    revoked_at: null,
    compromised_at: null,
  };
}

function deviceAuthorization(): StoredDeviceAuthorization {
  return {
    id: "dva_test",
    device_code_hash: "device-hash",
    user_code_hash: "user-hash",
    account_id: null,
    client_name: "barestash-cli",
    client_version: "0.1.0",
    device_name: "test-device",
    status: "pending",
    requested_scopes: ["events:read"],
    expires_at: "2026-07-13T00:10:00.000Z",
    poll_interval_seconds: 5,
    last_polled_at: null,
    created_at: "2026-07-13T00:00:00.000Z",
    approved_at: null,
    denied_at: null,
    consumed_at: null,
  };
}

function accessToken(): StoredAccessToken {
  return {
    id: "atk_ABCDEFGHIJKLMNOPQRSTUVWX",
    session_id: "cls_test",
    token_hash: "access-hash",
    status: "active",
    created_at: "2026-07-13T00:05:00.000Z",
    expires_at: "2026-07-13T01:05:00.000Z",
    last_used_at: null,
    revoked_at: null,
  };
}

function refreshToken(): StoredRefreshToken {
  return {
    id: "rtk_ZYXWVUTSRQPONMLKJIHGFEDC",
    session_id: "cls_test",
    token_hash: "refresh-hash",
    token_family_id: "family-test",
    status: "active",
    parent_token_id: null,
    replaced_by_token_id: null,
    created_at: "2026-07-13T00:05:00.000Z",
    expires_at: "2026-10-11T00:00:00.000Z",
    used_at: null,
    revoked_at: null,
  };
}
