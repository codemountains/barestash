import type { BrowserIdentityProfile } from "../../application/provision-account.js";

type D1ProviderProfileRow = {
  better_auth_user_id: string;
  provider: string;
  provider_subject: string;
  email: string;
  email_verified: number;
  display_name: string;
  avatar_url: string | null;
};

/** @public */
export class D1BetterAuthProfileRepository {
  constructor(private readonly db: D1Database) {}

  async findProfileByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<BrowserIdentityProfile | null> {
    const row = await this.db
      .prepare(`SELECT
        account."userId" AS better_auth_user_id,
        account."accountId" AS provider_subject,
        account."providerId" AS provider,
        user.email,
        user."emailVerified" AS email_verified,
        user.name AS display_name,
        user.image AS avatar_url
      FROM "account" AS account
      INNER JOIN "user" AS user ON user.id = account."userId"
      WHERE account."userId" = ?
        AND account."providerId" IN ('github', 'google')
      ORDER BY account."createdAt" ASC
      LIMIT 1`)
      .bind(betterAuthUserId)
      .first<D1ProviderProfileRow>();

    if (row === null) return null;
    if (row.provider !== "github" && row.provider !== "google") return null;

    return {
      betterAuthUserId: row.better_auth_user_id,
      provider: row.provider,
      providerSubject: row.provider_subject,
      email: row.email,
      emailVerified: row.email_verified === 1,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    };
  }
}
