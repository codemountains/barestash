import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { D1BetterAuthProfileRepository } from "./better-auth-profile-repository.js";

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
        };
      },
    };
  }
}

let database: DatabaseSync | undefined;

describe("D1BetterAuthProfileRepository", () => {
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it.each([
    "github",
    "google",
  ] as const)("reads only the %s identity and profile fields needed for provisioning", async (provider) => {
    const repository = await createRepository({ providerId: provider });

    const profile =
      await repository.findProfileByBetterAuthUserId("better-auth-user");

    expect(profile).toEqual({
      betterAuthUserId: "better-auth-user",
      provider,
      providerSubject: "123456",
      email: "user@example.com",
      emailVerified: true,
      displayName: "Example User",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    expect(JSON.stringify(profile)).not.toContain("raw-access-token-marker");
    expect(JSON.stringify(profile)).not.toContain("raw-refresh-token-marker");
  });

  it("ignores unsupported Better Auth provider accounts", async () => {
    const repository = await createRepository();
    database
      ?.prepare(`UPDATE "account" SET "providerId" = 'unsupported'`)
      .run();

    await expect(
      repository.findProfileByBetterAuthUserId("better-auth-user"),
    ).resolves.toBeNull();
  });
});

async function createRepository(
  options: { providerId?: string } = {},
): Promise<D1BetterAuthProfileRepository> {
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
  database.exec(
    await readFile(
      new URL("../../../../migrations/0001_better_auth.sql", import.meta.url),
      "utf8",
    ),
  );
  database.exec(`
    INSERT INTO "user" (
      id, name, email, emailVerified, image, createdAt, updatedAt
    ) VALUES (
      'better-auth-user', 'Example User', 'user@example.com', 1,
      'https://avatars.githubusercontent.com/u/1',
      '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'
    );
    INSERT INTO "account" (
      id, accountId, providerId, userId, accessToken, refreshToken, idToken,
      accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt,
      updatedAt
    ) VALUES (
      'better-auth-account', '123456', '${options.providerId ?? "github"}',
      'better-auth-user', 'raw-access-token-marker',
      'raw-refresh-token-marker', 'raw-id-token-marker', NULL, NULL,
      'read:user user:email', NULL, '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:00:00.000Z'
    );
  `);

  return new D1BetterAuthProfileRepository(
    new SqliteD1Database(database) as unknown as D1Database,
  );
}
