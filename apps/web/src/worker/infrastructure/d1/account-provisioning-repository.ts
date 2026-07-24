import type {
  BrowserAccount,
  BrowserAccountMapping,
  BrowserAccountProvisioningRepository,
  BrowserIdentity,
  InitialBrowserAccountRecords,
} from "../../application/provision-account.js";

type D1IdentityRow = Omit<BrowserIdentity, "email_verified"> & {
  email_verified: number;
};

/** @public */
export class D1BrowserAccountProvisioningRepository
  implements BrowserAccountProvisioningRepository
{
  constructor(private readonly db: D1Database) {}

  async findAccountById(
    id: BrowserAccount["id"],
  ): Promise<BrowserAccount | null> {
    return this.first<BrowserAccount>(
      "SELECT * FROM accounts WHERE id = ?",
      id,
    );
  }

  async findIdentityByProvider(
    provider: "github" | "google",
    providerSubject: string,
  ): Promise<BrowserIdentity | null> {
    const row = await this.first<D1IdentityRow>(
      "SELECT * FROM identities WHERE provider = ? AND provider_subject = ?",
      provider,
      providerSubject,
    );

    return row === null
      ? null
      : { ...row, email_verified: row.email_verified === 1 };
  }

  async findBrowserAccountMappingByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<BrowserAccountMapping | null> {
    return this.first<BrowserAccountMapping>(
      "SELECT * FROM better_auth_account_mappings WHERE better_auth_user_id = ?",
      betterAuthUserId,
    );
  }

  async createInitial(records: InitialBrowserAccountRecords): Promise<void> {
    await this.db.batch([
      this.insertAccount(records.account),
      this.insertIdentity(records.identity),
      this.insertBrowserAccountMapping(records.browserAccountMapping),
    ]);
  }

  async createIdentity(record: BrowserIdentity): Promise<void> {
    await this.insertIdentity(record).run();
  }

  async createBrowserAccountMapping(
    record: BrowserAccountMapping,
  ): Promise<void> {
    await this.insertBrowserAccountMapping(record).run();
  }

  async rebindBrowserAccountMapping(
    record: BrowserAccountMapping,
  ): Promise<void> {
    await this.db
      .prepare(`INSERT INTO better_auth_account_mappings (
        id, better_auth_user_id, account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        better_auth_user_id = excluded.better_auth_user_id,
        updated_at = excluded.updated_at`)
      .bind(
        record.id,
        record.better_auth_user_id,
        record.account_id,
        record.created_at,
        record.updated_at,
      )
      .run();
  }

  private insertAccount(record: BrowserAccount): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO accounts (
        id, primary_email, display_name, avatar_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.primary_email,
        record.display_name,
        record.avatar_url,
        record.status,
        record.created_at,
        record.updated_at,
      );
  }

  private insertIdentity(record: BrowserIdentity): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO identities (
        id, account_id, provider, provider_subject, email, email_verified,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.account_id,
        record.provider,
        record.provider_subject,
        record.email,
        record.email_verified ? 1 : 0,
        record.created_at,
        record.updated_at,
      );
  }

  private insertBrowserAccountMapping(
    record: BrowserAccountMapping,
  ): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO better_auth_account_mappings (
        id, better_auth_user_id, account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.better_auth_user_id,
        record.account_id,
        record.created_at,
        record.updated_at,
      );
  }

  private async first<T>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T | null> {
    return (
      (await this.db
        .prepare(query)
        .bind(...bindings)
        .first<T>()) ?? null
    );
  }
}
