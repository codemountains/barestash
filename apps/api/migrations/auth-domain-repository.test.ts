import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AuthDomainRecords,
  AuthDomainRepository,
} from "../src/domain/auth-domain.js";
import { D1AuthDomainRepository } from "../src/infrastructure/d1/auth-domain-repository.js";
import { InMemoryAuthDomainRepository } from "../src/infrastructure/in-memory/auth-domain-repository.js";

const records = {
  account: {
    id: "acc_example",
    primary_email: "user@example.com",
    display_name: "Example User",
    avatar_url: null,
    status: "active",
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
  },
  identity: {
    id: "idn_example",
    account_id: "acc_example",
    provider: "github",
    provider_subject: "123456",
    email: "user@example.com",
    email_verified: true,
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
  },
  browserAccountMapping: {
    id: "bam_example",
    better_auth_user_id: "better-auth-user",
    account_id: "acc_example",
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
  },
  deviceAuthorization: {
    id: "dva_example",
    device_code_hash: "hmac-sha256$device",
    user_code_hash: "hmac-sha256$user",
    account_id: null,
    client_name: "barestash-cli",
    client_version: "0.1.0",
    device_name: "example-device",
    status: "pending",
    requested_scopes: ["events:read", "mcp:use"],
    expires_at: "2026-07-12T12:10:00.000Z",
    poll_interval_seconds: 5,
    last_polled_at: null,
    created_at: "2026-07-12T12:00:00.000Z",
    approved_at: null,
    denied_at: null,
    consumed_at: null,
  },
  cliSession: {
    id: "cls_example",
    account_id: "acc_example",
    device_name: "example-device",
    client_version: "0.1.0",
    status: "active",
    scopes: ["events:read", "mcp:use"],
    created_at: "2026-07-12T12:00:00.000Z",
    last_used_at: null,
    idle_expires_at: "2026-08-11T12:00:00.000Z",
    absolute_expires_at: "2026-10-10T12:00:00.000Z",
    revoked_at: null,
    compromised_at: null,
  },
  accessToken: {
    id: "atk_example",
    session_id: "cls_example",
    token_hash: "hmac-sha256$access",
    status: "active",
    created_at: "2026-07-12T12:00:00.000Z",
    expires_at: "2026-07-12T13:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  },
  refreshToken: {
    id: "rtk_example",
    session_id: "cls_example",
    token_hash: "hmac-sha256$refresh",
    token_family_id: "family-example",
    status: "active",
    parent_token_id: null,
    replaced_by_token_id: null,
    created_at: "2026-07-12T12:00:00.000Z",
    expires_at: "2026-10-10T12:00:00.000Z",
    used_at: null,
    revoked_at: null,
  },
  personalAccessToken: {
    id: "tok_example",
    account_id: "acc_example",
    name: "CI",
    token_hash: "hmac-sha256$pat",
    status: "active",
    scopes: ["events:read"],
    created_at: "2026-07-12T12:00:00.000Z",
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  },
  patIdempotency: {
    id: "pid_example",
    account_id: "acc_example",
    idempotency_key: "logical-request-key",
    request_hash: "hmac-sha256$request",
    token_id: "tok_example",
    created_at: "2026-07-12T12:00:00.000Z",
    expires_at: "2026-07-13T12:00:00.000Z",
  },
} satisfies AuthDomainRecords;

async function expectRepositoryParity(repository: AuthDomainRepository) {
  await repository.createAccount(records.account);
  await repository.createIdentity(records.identity);
  await repository.createBrowserAccountMapping(records.browserAccountMapping);
  await expect(
    repository.createDeviceAuthorization(records.deviceAuthorization),
  ).resolves.toBe("created");
  await expect(
    repository.createDeviceAuthorization({
      ...records.deviceAuthorization,
      id: "dva_user_code_conflict",
      device_code_hash: "hmac-sha256$other-device",
    }),
  ).resolves.toBe("user_code_conflict");
  await expect(
    repository.findDeviceAuthorizationByDeviceCodeHash(
      "hmac-sha256$other-device",
    ),
  ).resolves.toBeNull();
  await expect(
    repository.createDeviceAuthorization({
      ...records.deviceAuthorization,
      device_code_hash: "hmac-sha256$duplicate-id-device",
      user_code_hash: "hmac-sha256$duplicate-id-user",
    }),
  ).rejects.toThrow(/UNIQUE/);
  await expect(
    repository.createDeviceAuthorization({
      ...records.deviceAuthorization,
      id: "dva_duplicate_device",
      user_code_hash: "hmac-sha256$duplicate-device-user",
    }),
  ).rejects.toThrow(/UNIQUE/);
  const concurrentReservations = await Promise.all([
    repository.createDeviceAuthorization({
      ...records.deviceAuthorization,
      id: "dva_concurrent_a",
      device_code_hash: "hmac-sha256$concurrent-device-a",
      user_code_hash: "hmac-sha256$concurrent-user",
    }),
    repository.createDeviceAuthorization({
      ...records.deviceAuthorization,
      id: "dva_concurrent_b",
      device_code_hash: "hmac-sha256$concurrent-device-b",
      user_code_hash: "hmac-sha256$concurrent-user",
    }),
  ]);
  expect(concurrentReservations.sort()).toEqual([
    "created",
    "user_code_conflict",
  ]);
  await repository.createCliSession(records.cliSession);
  await repository.createAccessToken(records.accessToken);
  await repository.createRefreshToken(records.refreshToken);
  await repository.createPersonalAccessToken(records.personalAccessToken);
  await repository.createPatIdempotencyRecord(records.patIdempotency);

  await expect(repository.findAccountById(records.account.id)).resolves.toEqual(
    records.account,
  );
  await expect(
    repository.findIdentityByProvider("github", "123456"),
  ).resolves.toEqual(records.identity);
  await expect(
    repository.findBrowserAccountMappingByBetterAuthUserId("better-auth-user"),
  ).resolves.toEqual(records.browserAccountMapping);
  await expect(
    repository.findDeviceAuthorizationByDeviceCodeHash("hmac-sha256$device"),
  ).resolves.toEqual(records.deviceAuthorization);
  await expect(
    repository.findDeviceAuthorizationByUserCodeHash("hmac-sha256$user"),
  ).resolves.toEqual(records.deviceAuthorization);
  await expect(
    repository.recordDeviceAuthorizationPoll(
      records.deviceAuthorization.id,
      "2026-07-12T12:01:00.000Z",
      "2026-07-12T11:56:00.000Z",
    ),
  ).resolves.toBe(true);
  await expect(
    repository.recordDeviceAuthorizationPoll(
      records.deviceAuthorization.id,
      "2026-07-12T12:01:00.000Z",
      "2026-07-12T11:56:00.000Z",
    ),
  ).resolves.toBe(false);
  await expect(
    repository.approveDeviceAuthorization(
      records.deviceAuthorization.id,
      records.account.id,
      "2026-07-12T12:02:00.000Z",
    ),
  ).resolves.toMatchObject({ status: "approved" });
  const exchangedSession = {
    ...records.cliSession,
    id: "cls_exchanged",
  } as const;
  const exchangedAccess = {
    ...records.accessToken,
    id: "atk_exchanged",
    session_id: exchangedSession.id,
    token_hash: "hmac-sha256$exchanged-access",
  } as const;
  const exchangedRefresh = {
    ...records.refreshToken,
    id: "rtk_exchanged",
    session_id: exchangedSession.id,
    token_hash: "hmac-sha256$exchanged-refresh",
  } as const;
  await expect(
    repository.exchangeDeviceAuthorization(
      records.deviceAuthorization.id,
      exchangedSession,
      exchangedAccess,
      exchangedRefresh,
      "2026-07-12T12:03:00.000Z",
    ),
  ).resolves.toBe("exchanged");
  await expect(
    repository.exchangeDeviceAuthorization(
      records.deviceAuthorization.id,
      exchangedSession,
      exchangedAccess,
      exchangedRefresh,
      "2026-07-12T12:03:00.000Z",
    ),
  ).resolves.toBe("authorization_unavailable");
  await expect(
    repository.findCliSessionById(records.cliSession.id),
  ).resolves.toEqual(records.cliSession);
  await expect(
    repository.findAccessTokenById(records.accessToken.id),
  ).resolves.toEqual(records.accessToken);
  await expect(
    repository.findRefreshTokenById(records.refreshToken.id),
  ).resolves.toEqual(records.refreshToken);
  await expect(
    repository.findPersonalAccessTokenById(records.personalAccessToken.id),
  ).resolves.toEqual(records.personalAccessToken);
  await expect(
    repository.findPatIdempotencyRecord(
      records.account.id,
      "logical-request-key",
    ),
  ).resolves.toEqual(records.patIdempotency);

  const usedAt = "2026-07-12T12:01:00.000Z";
  await repository.updateCliSessionLastUsed(records.cliSession.id, usedAt);
  await repository.updateAccessTokenLastUsed(records.accessToken.id, usedAt);
  await repository.updatePersonalAccessTokenLastUsed(
    records.personalAccessToken.id,
    usedAt,
  );
  await expect(
    repository.findCliSessionById(records.cliSession.id),
  ).resolves.toMatchObject({ last_used_at: usedAt });
  await expect(
    repository.findAccessTokenById(records.accessToken.id),
  ).resolves.toMatchObject({ last_used_at: usedAt });

  const atomicToken = {
    ...records.personalAccessToken,
    id: "tok_atomic",
    token_hash: "hmac-sha256$atomic",
  } as const;
  const atomicIdempotency = {
    ...records.patIdempotency,
    id: "pid_atomic",
    idempotency_key: "atomic-key",
    token_id: atomicToken.id,
  } as const;
  await repository.createPatIdempotencyRecord({
    ...records.patIdempotency,
    id: "pid_expired_unrelated",
    idempotency_key: "expired-unrelated-key",
    expires_at: "2026-07-12T11:59:59.000Z",
  });
  await expect(
    repository.createPersonalAccessTokenIdempotently(
      atomicToken,
      atomicIdempotency,
    ),
  ).resolves.toBe("created");
  await expect(
    repository.findPatIdempotencyRecord(
      records.account.id,
      "expired-unrelated-key",
    ),
  ).resolves.toBeNull();
  await expect(
    repository.createPersonalAccessTokenIdempotently(
      atomicToken,
      atomicIdempotency,
    ),
  ).resolves.toBe("existing");
  await expect(
    repository.listPersonalAccessTokens(records.account.id, {
      includeInactive: false,
      now: new Date("2026-07-12T12:02:00.000Z"),
    }),
  ).resolves.toHaveLength(2);

  await expect(
    repository.revokePersonalAccessToken(
      atomicToken.id,
      records.account.id,
      usedAt,
    ),
  ).resolves.toMatchObject({ status: "revoked", revoked_at: usedAt });
  await expect(
    repository.listPersonalAccessTokens(records.account.id, {
      includeInactive: false,
      now: new Date("2026-07-12T12:02:00.000Z"),
    }),
  ).resolves.toHaveLength(1);
}

async function expectDisabledAccountExchangeBlocked(
  repository: AuthDomainRepository,
) {
  const account = {
    ...records.account,
    id: "acc_disabled",
    status: "disabled",
  } as const;
  const authorization = {
    ...records.deviceAuthorization,
    id: "dva_disabled",
    device_code_hash: "hmac-sha256$disabled-device",
    user_code_hash: "hmac-sha256$disabled-user",
    account_id: account.id,
    status: "approved",
    approved_at: "2026-07-12T12:02:00.000Z",
  } as const;
  const session = {
    ...records.cliSession,
    id: "cls_disabled",
    account_id: account.id,
  } as const;
  const accessToken = {
    ...records.accessToken,
    id: "atk_disabled",
    session_id: session.id,
    token_hash: "hmac-sha256$disabled-access",
  } as const;
  const refreshToken = {
    ...records.refreshToken,
    id: "rtk_disabled",
    session_id: session.id,
    token_hash: "hmac-sha256$disabled-refresh",
  } as const;
  await repository.createAccount(account);
  await repository.createDeviceAuthorization(authorization);

  await expect(
    repository.exchangeDeviceAuthorization(
      authorization.id,
      session,
      accessToken,
      refreshToken,
      "2026-07-12T12:03:00.000Z",
    ),
  ).resolves.toBe("account_disabled");
  await expect(
    repository.findDeviceAuthorizationByDeviceCodeHash(
      authorization.device_code_hash,
    ),
  ).resolves.toMatchObject({ status: "approved", consumed_at: null });
  await expect(repository.findCliSessionById(session.id)).resolves.toBeNull();
  await expect(
    repository.findAccessTokenById(accessToken.id),
  ).resolves.toBeNull();
  await expect(
    repository.findRefreshTokenById(refreshToken.id),
  ).resolves.toBeNull();
}

async function expectConstraintParity(repository: AuthDomainRepository) {
  await repository.createAccount(records.account);

  await expect(
    repository.createAccessToken(records.accessToken),
  ).rejects.toThrow(/FOREIGN KEY/);

  await repository.createIdentity(records.identity);
  await expect(
    repository.createIdentity({
      ...records.identity,
      id: "idn_duplicate",
    }),
  ).rejects.toThrow(/UNIQUE/);

  await repository.createCliSession(records.cliSession);
  await repository.createPersonalAccessToken(records.personalAccessToken);
  await repository.createPatIdempotencyRecord(records.patIdempotency);
  await expect(
    repository.createPatIdempotencyRecord({
      ...records.patIdempotency,
      id: "pid_duplicate",
    }),
  ).rejects.toThrow(/UNIQUE/);

  const otherAccount = {
    ...records.account,
    id: "acc_other",
    primary_email: "other@example.com",
  } as const;
  const otherToken = {
    ...records.personalAccessToken,
    id: "tok_other",
    account_id: otherAccount.id,
    token_hash: "hmac-sha256$other-pat",
  } as const;
  await repository.createAccount(otherAccount);
  await repository.createPersonalAccessToken(otherToken);
  await expect(
    repository.createPatIdempotencyRecord({
      ...records.patIdempotency,
      id: "pid_cross_account",
      idempotency_key: "cross-account-key",
      token_id: otherToken.id,
    }),
  ).rejects.toThrow(/FOREIGN KEY/);
}

class SqliteD1Database {
  #batchTail: Promise<void> = Promise.resolve();

  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    const statement = this.database.prepare(query);
    const returnsRows = /^\s*SELECT\b/i.test(query);
    let values: unknown[] = [];

    return {
      bind: (...bindings: unknown[]) => {
        values = bindings;
        return this.prepareBound(statement, () => values, returnsRows);
      },
      first: async () => statement.get(...values) ?? null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => {
        if (returnsRows) {
          return { meta: { changes: 0 }, results: statement.all(...values) };
        }
        const result = statement.run(...values);
        return { meta: { changes: result.changes } };
      },
    };
  }

  async batch(statements: { run: () => Promise<unknown> }[]) {
    const previous = this.#batchTail;
    let release = () => {};
    this.#batchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }

  private prepareBound(
    statement: ReturnType<DatabaseSync["prepare"]>,
    values: () => unknown[],
    returnsRows: boolean,
  ) {
    return {
      first: async () => statement.get(...values()) ?? null,
      all: async () => ({ results: statement.all(...values()) }),
      run: async () => {
        if (returnsRows) {
          return {
            meta: { changes: 0 },
            results: statement.all(...values()),
          };
        }
        const result = statement.run(...values());
        return { meta: { changes: result.changes } };
      },
    };
  }
}

describe("auth domain repositories", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    if (database?.isOpen) database.close();
    database = undefined;
  });

  it("stores every auth domain record in memory without raw secrets", async () => {
    await expectRepositoryParity(new InMemoryAuthDomainRepository());
  });

  it("stores every auth domain record in D1 with JSON scope parity", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(
          new URL("0003_auth_domain_foundation.sql", import.meta.url),
          "utf8",
        ),
      ),
    );
    const d1 = new SqliteD1Database(database);

    await expectRepositoryParity(
      new D1AuthDomainRepository(d1 as unknown as D1Database),
    );
  });

  it("blocks disabled-account exchange in memory", async () => {
    await expectDisabledAccountExchangeBlocked(
      new InMemoryAuthDomainRepository(),
    );
  });

  it("blocks disabled-account exchange atomically in D1", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(
          new URL("0003_auth_domain_foundation.sql", import.meta.url),
          "utf8",
        ),
      ),
    );
    await expectDisabledAccountExchangeBlocked(
      new D1AuthDomainRepository(
        new SqliteD1Database(database) as unknown as D1Database,
      ),
    );
  });

  it("serializes concurrent D1 polling and single-use token exchange", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(
          new URL("0003_auth_domain_foundation.sql", import.meta.url),
          "utf8",
        ),
      ),
    );
    const repository = new D1AuthDomainRepository(
      new SqliteD1Database(database) as unknown as D1Database,
    );
    await repository.createAccount(records.account);
    const authorization = {
      ...records.deviceAuthorization,
      id: "dva_concurrent",
      device_code_hash: "hmac-sha256$concurrent-device",
      user_code_hash: "hmac-sha256$concurrent-user",
    } as const;
    await repository.createDeviceAuthorization(authorization);

    const polls = await Promise.all([
      repository.recordDeviceAuthorizationPoll(
        authorization.id,
        "2026-07-12T12:01:00.000Z",
        "2026-07-12T11:56:00.000Z",
      ),
      repository.recordDeviceAuthorizationPoll(
        authorization.id,
        "2026-07-12T12:01:00.000Z",
        "2026-07-12T11:56:00.000Z",
      ),
    ]);
    expect(polls.sort()).toEqual([false, true]);
    await repository.approveDeviceAuthorization(
      authorization.id,
      records.account.id,
      "2026-07-12T12:02:00.000Z",
    );

    const exchanges = ["a", "b"].map((suffix) => {
      const session = {
        ...records.cliSession,
        id: `cls_race_${suffix}` as const,
      };
      const accessToken = {
        ...records.accessToken,
        id: `atk_race_${suffix}` as const,
        session_id: session.id,
        token_hash: `hmac-sha256$race-access-${suffix}`,
      };
      const refreshToken = {
        ...records.refreshToken,
        id: `rtk_race_${suffix}` as const,
        session_id: session.id,
        token_hash: `hmac-sha256$race-refresh-${suffix}`,
      };
      return { session, accessToken, refreshToken };
    });
    const results = await Promise.all(
      exchanges.map(({ session, accessToken, refreshToken }) =>
        repository.exchangeDeviceAuthorization(
          authorization.id,
          session,
          accessToken,
          refreshToken,
          "2026-07-12T12:03:00.000Z",
        ),
      ),
    );

    expect(results.filter((result) => result === "exchanged")).toHaveLength(1);
    const losingIndex = results.indexOf("authorization_unavailable");
    const losing = exchanges[losingIndex];
    expect(losing).toBeDefined();
    await expect(
      repository.findCliSessionById(losing?.session.id ?? "cls_missing"),
    ).resolves.toBeNull();
    await expect(
      repository.findAccessTokenById(losing?.accessToken.id ?? "atk_missing"),
    ).resolves.toBeNull();
    await expect(
      repository.findRefreshTokenById(losing?.refreshToken.id ?? "rtk_missing"),
    ).resolves.toBeNull();
  });

  it("enforces D1 uniqueness and references in memory", async () => {
    await expectConstraintParity(new InMemoryAuthDomainRepository());
  });

  it("enforces uniqueness and references in D1", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(
          new URL("0003_auth_domain_foundation.sql", import.meta.url),
          "utf8",
        ),
      ),
    );
    const d1 = new SqliteD1Database(database);

    await expectConstraintParity(
      new D1AuthDomainRepository(d1 as unknown as D1Database),
    );
  });
});
