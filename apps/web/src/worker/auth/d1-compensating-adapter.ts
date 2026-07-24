import type { BetterAuthOptions } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";

type BetterAuthAdapter = Awaited<ReturnType<typeof getAdapter>>;

const ORPHAN_GRACE_PERIOD_MS = 60_000;

export async function createD1CompensatingAdapter(
  options: BetterAuthOptions,
  database: D1Database,
): Promise<BetterAuthAdapter> {
  const adapter = await getAdapter(options);

  const findOne = (async <T>(
    input: Parameters<BetterAuthAdapter["findOne"]>[0],
  ): Promise<T | null> => {
    const record = await adapter.findOne<T>(input);
    if (!isStaleUserLookupByEmail(input, record)) return record;

    const deletion = await database
      .prepare(
        `DELETE FROM "user"
         WHERE "id" = ?
           AND NOT EXISTS (
             SELECT 1 FROM "account" WHERE "account"."userId" = "user"."id"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "session" WHERE "session"."userId" = "user"."id"
           )`,
      )
      .bind(record.id)
      .run();

    return deletion.meta.changes === 0 ? record : null;
  }) as BetterAuthAdapter["findOne"];

  return {
    ...adapter,
    findOne,
    transaction: async <T>(
      callback: (transactionAdapter: BetterAuthAdapter) => Promise<T>,
    ): Promise<T> => {
      const createdUserIds: string[] = [];
      const createInTransaction = (async (
        input: Parameters<BetterAuthAdapter["create"]>[0],
      ) => {
        const created = await adapter.create(input);
        if (
          input.model === "user" &&
          created !== null &&
          typeof created === "object" &&
          "id" in created &&
          typeof created.id === "string"
        ) {
          createdUserIds.push(created.id);
        }
        return created;
      }) as BetterAuthAdapter["create"];
      const transactionAdapter: BetterAuthAdapter = {
        ...adapter,
        create: createInTransaction,
      };

      try {
        return await callback(transactionAdapter);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const userId of createdUserIds.reverse()) {
          try {
            await adapter.delete({
              model: "user",
              where: [{ field: "id", value: userId }],
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }

        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Better Auth transaction failed and its partial user could not be removed.",
          );
        }
        throw error;
      }
    },
  };
}

function isStaleUserLookupByEmail(
  input: Parameters<BetterAuthAdapter["findOne"]>[0],
  record: unknown,
): record is { id: string; createdAt: Date | number | string } {
  if (
    input.model !== "user" ||
    !input.where.some((condition) => condition.field === "email") ||
    record === null ||
    typeof record !== "object" ||
    !("id" in record) ||
    typeof record.id !== "string" ||
    !("createdAt" in record)
  ) {
    return false;
  }

  const createdAt =
    record.createdAt instanceof Date
      ? record.createdAt.getTime()
      : new Date(record.createdAt as number | string).getTime();

  return (
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= ORPHAN_GRACE_PERIOD_MS
  );
}
