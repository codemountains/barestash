import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { D1DeviceApprovalRepository } from "./device-approval-repository.js";

describe("D1DeviceApprovalRepository", () => {
  let sqlite: DatabaseSync;
  let repository: D1DeviceApprovalRepository;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(
      readFileSync(
        new URL(
          "../../../../../api/migrations/0003_auth_domain_foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    sqlite.exec(`
      INSERT INTO accounts VALUES (
        'acc_test', 'user@example.com', 'Test User', NULL, 'active',
        '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
      );
      INSERT INTO better_auth_account_mappings VALUES (
        'bam_test', 'better-auth-user', 'acc_test',
        '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
      );
      INSERT INTO device_authorizations VALUES (
        'dva_test', 'device-hash', 'user-hash', NULL, 'barestash-cli',
        '0.1.0', 'test-device', 'pending', '["events:read"]',
        '2026-07-13T00:10:00.000Z', 5, NULL,
        '2026-07-13T00:00:00.000Z', NULL, NULL, NULL
      );
    `);
    repository = new D1DeviceApprovalRepository(
      new SqliteD1Database(sqlite) as never,
    );
  });

  afterEach(() => sqlite.close());

  it("allows exactly one conditional approval transition", async () => {
    const results = await Promise.all([
      repository.approveDeviceAuthorization(
        "dva_test",
        "acc_test",
        "2026-07-13T00:05:00.000Z",
      ),
      repository.approveDeviceAuthorization(
        "dva_test",
        "acc_test",
        "2026-07-13T00:05:00.000Z",
      ),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("rejects approval atomically when the account is disabled", async () => {
    sqlite.exec(
      "UPDATE accounts SET status = 'disabled' WHERE id = 'acc_test'",
    );

    const result = await repository.approveDeviceAuthorization(
      "dva_test",
      "acc_test",
      "2026-07-13T00:05:00.000Z",
    );

    expect(result).toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT status FROM device_authorizations WHERE id = 'dva_test'",
        )
        .get(),
    ).toEqual({ status: "pending" });
  });
});

class SqliteD1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string) {
    const statement = this.database.prepare(query);
    let bindings: unknown[] = [];
    return {
      bind: (...values: unknown[]) => {
        bindings = values;
        return {
          first: async () => statement.get(...bindings) ?? null,
          run: async () => {
            const result = statement.run(...bindings);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }
}
