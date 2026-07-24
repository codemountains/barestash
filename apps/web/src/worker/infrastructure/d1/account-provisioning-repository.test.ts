import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { InitialBrowserAccountRecords } from "../../application/provision-account.js";
import { D1BrowserAccountProvisioningRepository } from "./account-provisioning-repository.js";

const records = {
  account: {
    id: "acc_example",
    primary_email: "user@example.com",
    display_name: "Example User",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
    status: "active",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
  },
  identity: {
    id: "idn_example",
    account_id: "acc_example",
    provider: "github",
    provider_subject: "123456",
    email: "user@example.com",
    email_verified: true,
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
  },
  browserAccountMapping: {
    id: "bam_example",
    better_auth_user_id: "better-auth-user",
    account_id: "acc_example",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
  },
} satisfies InitialBrowserAccountRecords;

class SqliteD1Database {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    const statement = this.database.prepare(query);
    let values: unknown[] = [];

    return {
      bind: (...bindings: unknown[]) => {
        values = bindings;
        return {
          first: async () => statement.get(...values) ?? null,
          run: async () => statement.run(...values),
        };
      },
      first: async () => statement.get(...values) ?? null,
      run: async () => statement.run(...values),
    };
  }

  async batch(statements: { run: () => Promise<unknown> }[]) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

let database: DatabaseSync | undefined;

describe("D1BrowserAccountProvisioningRepository", () => {
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("persists the account, GitHub identity, and browser mapping together", async () => {
    const repository = await createRepository();

    await repository.createInitial(records);

    await expect(repository.findAccountById("acc_example")).resolves.toEqual(
      records.account,
    );
    await expect(
      repository.findIdentityByProvider("github", "123456"),
    ).resolves.toEqual(records.identity);
    await expect(
      repository.findBrowserAccountMappingByBetterAuthUserId(
        "better-auth-user",
      ),
    ).resolves.toEqual(records.browserAccountMapping);
  });

  it("rolls back the initial records when a mapping conflict prevents provisioning", async () => {
    const repository = await createRepository();
    await repository.createInitial(records);

    await expect(
      repository.createInitial({
        account: { ...records.account, id: "acc_rolled_back" },
        identity: {
          ...records.identity,
          id: "idn_rolled_back",
          account_id: "acc_rolled_back",
          provider_subject: "654321",
        },
        browserAccountMapping: {
          ...records.browserAccountMapping,
          id: "bam_rolled_back",
          account_id: "acc_rolled_back",
        },
      }),
    ).rejects.toThrow(/UNIQUE/);

    await expect(
      repository.findAccountById("acc_rolled_back"),
    ).resolves.toBeNull();
    await expect(
      repository.findIdentityByProvider("github", "654321"),
    ).resolves.toBeNull();
  });

  it("rebinds an existing account mapping to the current Better Auth user", async () => {
    const repository = await createRepository();
    await repository.createInitial(records);

    await repository.rebindBrowserAccountMapping({
      ...records.browserAccountMapping,
      id: "bam_replacement",
      better_auth_user_id: "replacement-better-auth-user",
      updated_at: "2026-07-13T13:00:00.000Z",
    });

    await expect(
      repository.findBrowserAccountMappingByBetterAuthUserId(
        "better-auth-user",
      ),
    ).resolves.toBeNull();
    await expect(
      repository.findBrowserAccountMappingByBetterAuthUserId(
        "replacement-better-auth-user",
      ),
    ).resolves.toMatchObject({
      id: "bam_example",
      account_id: "acc_example",
      updated_at: "2026-07-13T13:00:00.000Z",
    });
  });
});

async function createRepository() {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    await readFile(
      new URL(
        "../../../../../api/migrations/0003_auth_domain_foundation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  return new D1BrowserAccountProvisioningRepository(
    new SqliteD1Database(database) as unknown as D1Database,
  );
}
