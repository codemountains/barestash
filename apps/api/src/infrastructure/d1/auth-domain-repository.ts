import type {
  AuthDomainRepository,
  DeviceAuthorizationExchangeResult,
  IdentityProvider,
  StoredAccessToken,
  StoredAccount,
  StoredBrowserAccountMapping,
  StoredCliSession,
  StoredDeviceAuthorization,
  StoredIdentity,
  StoredPatIdempotencyRecord,
  StoredPersonalAccessToken,
  StoredRefreshToken,
} from "../../domain/auth-domain.js";

type D1DeviceAuthorizationRow = Omit<
  StoredDeviceAuthorization,
  "requested_scopes"
> & { requested_scopes_json: string };
type D1DeviceAuthorizationExchangeStateRow = {
  authorization_status: StoredDeviceAuthorization["status"];
  account_id: StoredDeviceAuthorization["account_id"];
  expires_at: string;
  account_status: StoredAccount["status"] | null;
};
type D1CliSessionRow = Omit<StoredCliSession, "scopes"> & {
  scopes_json: string;
};
type D1PersonalAccessTokenRow = Omit<StoredPersonalAccessToken, "scopes"> & {
  scopes_json: string;
};
type D1IdentityRow = Omit<StoredIdentity, "email_verified"> & {
  email_verified: number;
};

/** @public */
export class D1AuthDomainRepository implements AuthDomainRepository {
  constructor(readonly db: D1Database) {}

  async createAccount(record: StoredAccount): Promise<void> {
    await this.db
      .prepare(`INSERT INTO accounts (
        id, primary_email, display_name, avatar_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        ...values(record, [
          "id",
          "primary_email",
          "display_name",
          "avatar_url",
          "status",
          "created_at",
          "updated_at",
        ]),
      )
      .run();
  }

  async createAccountIfAbsent(record: StoredAccount): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO accounts (
        id, primary_email, display_name, avatar_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        ...values(record, [
          "id",
          "primary_email",
          "display_name",
          "avatar_url",
          "status",
          "created_at",
          "updated_at",
        ]),
      )
      .run();
  }

  async findAccountById(id: StoredAccount["id"]) {
    return this.first<StoredAccount>("SELECT * FROM accounts WHERE id = ?", id);
  }

  async createIdentity(record: StoredIdentity): Promise<void> {
    await this.db
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
      )
      .run();
  }

  async findIdentityByProvider(
    provider: IdentityProvider,
    providerSubject: string,
  ) {
    const row = await this.first<D1IdentityRow>(
      "SELECT * FROM identities WHERE provider = ? AND provider_subject = ?",
      provider,
      providerSubject,
    );
    return row === null
      ? null
      : { ...row, email_verified: row.email_verified === 1 };
  }

  async createBrowserAccountMapping(record: StoredBrowserAccountMapping) {
    await this.db
      .prepare(`INSERT INTO better_auth_account_mappings (
        id, better_auth_user_id, account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.better_auth_user_id,
        record.account_id,
        record.created_at,
        record.updated_at,
      )
      .run();
  }

  async findBrowserAccountMappingByBetterAuthUserId(betterAuthUserId: string) {
    return this.first<StoredBrowserAccountMapping>(
      "SELECT * FROM better_auth_account_mappings WHERE better_auth_user_id = ?",
      betterAuthUserId,
    );
  }

  async createDeviceAuthorization(record: StoredDeviceAuthorization) {
    const result = await this.db
      .prepare(`INSERT INTO device_authorizations (
        id, device_code_hash, user_code_hash, account_id, client_name,
        client_version, device_name, status, requested_scopes_json, expires_at,
        poll_interval_seconds, last_polled_at, created_at, approved_at,
        denied_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_code_hash) DO NOTHING`)
      .bind(
        record.id,
        record.device_code_hash,
        record.user_code_hash,
        record.account_id,
        record.client_name,
        record.client_version,
        record.device_name,
        record.status,
        JSON.stringify(record.requested_scopes),
        record.expires_at,
        record.poll_interval_seconds,
        record.last_polled_at,
        record.created_at,
        record.approved_at,
        record.denied_at,
        record.consumed_at,
      )
      .run();
    return result.meta.changes === 1 ? "created" : "user_code_conflict";
  }

  async findDeviceAuthorizationByDeviceCodeHash(deviceCodeHash: string) {
    const row = await this.first<D1DeviceAuthorizationRow>(
      "SELECT * FROM device_authorizations WHERE device_code_hash = ?",
      deviceCodeHash,
    );
    return row === null
      ? null
      : mapScopes(row, "requested_scopes_json", "requested_scopes");
  }

  async findDeviceAuthorizationByUserCodeHash(userCodeHash: string) {
    const row = await this.first<D1DeviceAuthorizationRow>(
      "SELECT * FROM device_authorizations WHERE user_code_hash = ?",
      userCodeHash,
    );
    return row === null
      ? null
      : mapScopes(row, "requested_scopes_json", "requested_scopes");
  }

  async recordDeviceAuthorizationPoll(
    id: StoredDeviceAuthorization["id"],
    polledAt: string,
    allowedBefore: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE device_authorizations SET last_polled_at = ?
        WHERE id = ? AND (last_polled_at IS NULL OR last_polled_at <= ?)`)
      .bind(polledAt, id, allowedBefore)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async approveDeviceAuthorization(
    id: StoredDeviceAuthorization["id"],
    accountId: StoredAccount["id"],
    approvedAt: string,
  ) {
    const result = await this.db
      .prepare(`UPDATE device_authorizations
        SET status = 'approved', account_id = ?, approved_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?`)
      .bind(accountId, approvedAt, id, approvedAt)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) return null;
    return this.findDeviceAuthorizationByIdAndStatus(id, "approved");
  }

  async denyDeviceAuthorization(
    id: StoredDeviceAuthorization["id"],
    deniedAt: string,
  ) {
    const result = await this.db
      .prepare(`UPDATE device_authorizations
        SET status = 'denied', denied_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?`)
      .bind(deniedAt, id, deniedAt)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) return null;
    return this.findDeviceAuthorizationByIdAndStatus(id, "denied");
  }

  async expireDeviceAuthorization(id: StoredDeviceAuthorization["id"]) {
    const result = await this.db
      .prepare(`UPDATE device_authorizations SET status = 'expired'
        WHERE id = ? AND status = 'pending'`)
      .bind(id)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) return null;
    return this.findDeviceAuthorizationByIdAndStatus(id, "expired");
  }

  async exchangeDeviceAuthorization(
    authorizationId: StoredDeviceAuthorization["id"],
    session: StoredCliSession,
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    consumedAt: string,
  ): Promise<DeviceAuthorizationExchangeResult> {
    const consume = this.db
      .prepare(`UPDATE device_authorizations
        SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'approved' AND account_id = ?
          AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = device_authorizations.account_id
              AND accounts.status = 'active'
          )`)
      .bind(consumedAt, authorizationId, session.account_id, consumedAt);
    const insertSession = this.db
      .prepare(`INSERT INTO cli_sessions (
        id, account_id, device_name, client_version, status, scopes_json,
        created_at, last_used_at, idle_expires_at, absolute_expires_at,
        revoked_at, compromised_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1`)
      .bind(
        session.id,
        session.account_id,
        session.device_name,
        session.client_version,
        session.status,
        JSON.stringify(session.scopes),
        session.created_at,
        session.last_used_at,
        session.idle_expires_at,
        session.absolute_expires_at,
        session.revoked_at,
        session.compromised_at,
      );
    const insertAccess = this.db
      .prepare(`INSERT INTO access_tokens (
        id, session_id, token_hash, status, created_at, expires_at,
        last_used_at, revoked_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1`)
      .bind(
        accessToken.id,
        session.id,
        accessToken.token_hash,
        accessToken.status,
        accessToken.created_at,
        accessToken.expires_at,
        accessToken.last_used_at,
        accessToken.revoked_at,
      );
    const insertRefresh = this.db
      .prepare(`INSERT INTO refresh_tokens (
        id, session_id, token_hash, token_family_id, status, parent_token_id,
        replaced_by_token_id, created_at, expires_at, used_at, revoked_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1`)
      .bind(
        refreshToken.id,
        session.id,
        refreshToken.token_hash,
        refreshToken.token_family_id,
        refreshToken.status,
        refreshToken.parent_token_id,
        refreshToken.replaced_by_token_id,
        refreshToken.created_at,
        refreshToken.expires_at,
        refreshToken.used_at,
        refreshToken.revoked_at,
      );
    const exchangeState = this.db
      .prepare(`SELECT
          device_authorizations.status AS authorization_status,
          device_authorizations.account_id,
          device_authorizations.expires_at,
          accounts.status AS account_status
        FROM device_authorizations
        LEFT JOIN accounts ON accounts.id = device_authorizations.account_id
        WHERE device_authorizations.id = ?`)
      .bind(authorizationId);

    try {
      const results = await this.db.batch([
        consume,
        insertSession,
        insertAccess,
        insertRefresh,
        exchangeState,
      ]);
      if ((results[0]?.meta?.changes ?? 0) === 1) return "exchanged";
      const state = results[4]?.results[0] as
        | D1DeviceAuthorizationExchangeStateRow
        | undefined;
      if (
        state?.authorization_status === "approved" &&
        state.account_id === session.account_id &&
        state.expires_at > consumedAt &&
        state.account_status !== "active"
      ) {
        return "account_disabled";
      }
      return "authorization_unavailable";
    } catch (error) {
      const current = await this.findDeviceAuthorizationById(authorizationId);
      if (current?.status === "consumed") {
        return "authorization_unavailable";
      }
      throw error;
    }
  }

  async createCliSession(record: StoredCliSession) {
    await this.db
      .prepare(`INSERT INTO cli_sessions (
        id, account_id, device_name, client_version, status, scopes_json,
        created_at, last_used_at, idle_expires_at, absolute_expires_at,
        revoked_at, compromised_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.account_id,
        record.device_name,
        record.client_version,
        record.status,
        JSON.stringify(record.scopes),
        record.created_at,
        record.last_used_at,
        record.idle_expires_at,
        record.absolute_expires_at,
        record.revoked_at,
        record.compromised_at,
      )
      .run();
  }

  async findCliSessionById(id: StoredCliSession["id"]) {
    const row = await this.first<D1CliSessionRow>(
      "SELECT * FROM cli_sessions WHERE id = ?",
      id,
    );
    return row === null ? null : mapScopes(row, "scopes_json", "scopes");
  }

  async updateCliSessionLastUsed(
    id: StoredCliSession["id"],
    lastUsedAt: string,
  ): Promise<void> {
    await this.db
      .prepare("UPDATE cli_sessions SET last_used_at = ? WHERE id = ?")
      .bind(lastUsedAt, id)
      .run();
  }

  async createAccessToken(record: StoredAccessToken) {
    await this.db
      .prepare(`INSERT INTO access_tokens (
        id, session_id, token_hash, status, created_at, expires_at,
        last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        ...values(record, [
          "id",
          "session_id",
          "token_hash",
          "status",
          "created_at",
          "expires_at",
          "last_used_at",
          "revoked_at",
        ]),
      )
      .run();
  }

  async findAccessTokenById(id: StoredAccessToken["id"]) {
    return this.first<StoredAccessToken>(
      "SELECT * FROM access_tokens WHERE id = ?",
      id,
    );
  }

  async updateAccessTokenLastUsed(
    id: StoredAccessToken["id"],
    lastUsedAt: string,
  ): Promise<void> {
    await this.db
      .prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
      .bind(lastUsedAt, id)
      .run();
  }

  async createRefreshToken(record: StoredRefreshToken) {
    await this.db
      .prepare(`INSERT INTO refresh_tokens (
        id, session_id, token_hash, token_family_id, status, parent_token_id,
        replaced_by_token_id, created_at, expires_at, used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        ...values(record, [
          "id",
          "session_id",
          "token_hash",
          "token_family_id",
          "status",
          "parent_token_id",
          "replaced_by_token_id",
          "created_at",
          "expires_at",
          "used_at",
          "revoked_at",
        ]),
      )
      .run();
  }

  async findRefreshTokenById(id: StoredRefreshToken["id"]) {
    return this.first<StoredRefreshToken>(
      "SELECT * FROM refresh_tokens WHERE id = ?",
      id,
    );
  }

  async rotateRefreshToken(
    currentTokenId: StoredRefreshToken["id"],
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    lastUsedAt: string,
    idleExpiresAt: string,
  ) {
    const insertAccess = this.db
      .prepare(`INSERT INTO access_tokens (
        id, session_id, token_hash, status, created_at, expires_at,
        last_used_at, revoked_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM refresh_tokens
          JOIN cli_sessions ON cli_sessions.id = refresh_tokens.session_id
          JOIN accounts ON accounts.id = cli_sessions.account_id
          WHERE refresh_tokens.id = ?
            AND refresh_tokens.status = 'active'
            AND cli_sessions.status = 'active'
            AND cli_sessions.idle_expires_at > ?
            AND cli_sessions.absolute_expires_at > ?
            AND accounts.status = 'active'
        )`)
      .bind(
        accessToken.id,
        accessToken.session_id,
        accessToken.token_hash,
        accessToken.status,
        accessToken.created_at,
        accessToken.expires_at,
        accessToken.last_used_at,
        accessToken.revoked_at,
        currentTokenId,
        lastUsedAt,
        lastUsedAt,
      );
    const insertRefresh = this.db
      .prepare(`INSERT INTO refresh_tokens (
        id, session_id, token_hash, token_family_id, status, parent_token_id,
        replaced_by_token_id, created_at, expires_at, used_at, revoked_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(
        refreshToken.id,
        refreshToken.session_id,
        refreshToken.token_hash,
        refreshToken.token_family_id,
        refreshToken.status,
        refreshToken.parent_token_id,
        refreshToken.replaced_by_token_id,
        refreshToken.created_at,
        refreshToken.expires_at,
        refreshToken.used_at,
        refreshToken.revoked_at,
      );
    const consume = this.db
      .prepare(`UPDATE refresh_tokens
        SET status = 'used', used_at = ?, replaced_by_token_id = ?
        WHERE id = ? AND status = 'active' AND changes() = 1`)
      .bind(lastUsedAt, refreshToken.id, currentTokenId);
    const updateSession = this.db
      .prepare(`UPDATE cli_sessions
        SET last_used_at = ?, idle_expires_at = ?
        WHERE id = ? AND changes() = 1`)
      .bind(lastUsedAt, idleExpiresAt, refreshToken.session_id);
    // D1 rolls back the batch on an error. Deliberately violate NOT NULL when
    // an earlier insert exists but the guarded mutation chain did not finish.
    const rollbackIncompleteRotation = this.db
      .prepare(`INSERT INTO access_tokens (
        id, session_id, token_hash, status, created_at, expires_at,
        last_used_at, revoked_at
      ) SELECT ?, NULL, NULL, 'invalid', NULL, NULL, NULL, NULL
        WHERE changes() <> 1
          AND (
            EXISTS (SELECT 1 FROM access_tokens WHERE id = ?)
            OR EXISTS (SELECT 1 FROM refresh_tokens WHERE id = ?)
          )`)
      .bind(accessToken.id, accessToken.id, refreshToken.id);
    const results = await this.db.batch([
      insertAccess,
      insertRefresh,
      consume,
      updateSession,
      rollbackIncompleteRotation,
    ]);
    if (
      results.slice(0, 4).every((result) => (result.meta?.changes ?? 0) === 1)
    ) {
      return "rotated" as const;
    }

    const current = await this.findRefreshTokenById(currentTokenId);
    if (current?.status === "used") {
      await this.compromiseCliSession(
        current.session_id,
        current.token_family_id,
        lastUsedAt,
      );
      return "reuse_detected" as const;
    }
    if (current?.status === "active") {
      const session = await this.findCliSessionById(current.session_id);
      if (
        session !== null &&
        (session.idle_expires_at <= lastUsedAt ||
          session.absolute_expires_at <= lastUsedAt)
      ) {
        return "session_expired" as const;
      }
      if (session !== null) {
        const account = await this.findAccountById(session.account_id);
        if (account?.status === "disabled") return "account_disabled" as const;
      }
    }
    return "session_unavailable" as const;
  }

  async compromiseCliSession(
    sessionId: StoredCliSession["id"],
    tokenFamilyId: string,
    compromisedAt: string,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`UPDATE cli_sessions
          SET status = 'compromised', compromised_at = COALESCE(compromised_at, ?)
          WHERE id = ?`)
        .bind(compromisedAt, sessionId),
      this.db
        .prepare(`UPDATE access_tokens
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE session_id = ? AND status <> 'revoked'`)
        .bind(compromisedAt, sessionId),
      this.db
        .prepare(`UPDATE refresh_tokens
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE token_family_id = ? AND status <> 'revoked'`)
        .bind(compromisedAt, tokenFamilyId),
    ]);
  }

  async revokeCliSession(sessionId: StoredCliSession["id"], revokedAt: string) {
    await this.db.batch([
      this.db
        .prepare(`UPDATE cli_sessions
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE id = ?`)
        .bind(revokedAt, sessionId),
      this.db
        .prepare(`UPDATE access_tokens
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE session_id = ? AND status <> 'revoked'`)
        .bind(revokedAt, sessionId),
      this.db
        .prepare(`UPDATE refresh_tokens
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE session_id = ? AND status <> 'revoked'`)
        .bind(revokedAt, sessionId),
    ]);
    return this.findCliSessionById(sessionId);
  }

  async createPersonalAccessToken(record: StoredPersonalAccessToken) {
    await this.db
      .prepare(`INSERT INTO personal_access_tokens (
        id, account_id, name, token_hash, status, scopes_json, created_at,
        expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.account_id,
        record.name,
        record.token_hash,
        record.status,
        JSON.stringify(record.scopes),
        record.created_at,
        record.expires_at,
        record.last_used_at,
        record.revoked_at,
      )
      .run();
  }

  async findPersonalAccessTokenById(id: StoredPersonalAccessToken["id"]) {
    const row = await this.first<D1PersonalAccessTokenRow>(
      "SELECT * FROM personal_access_tokens WHERE id = ?",
      id,
    );
    return row === null ? null : mapScopes(row, "scopes_json", "scopes");
  }

  async updatePersonalAccessTokenLastUsed(
    id: StoredPersonalAccessToken["id"],
    lastUsedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?",
      )
      .bind(lastUsedAt, id)
      .run();
  }

  async listPersonalAccessTokens(
    accountId: StoredAccount["id"],
    options: { includeInactive: boolean; now: Date },
  ): Promise<StoredPersonalAccessToken[]> {
    const result = await this.db
      .prepare(`SELECT * FROM personal_access_tokens
        WHERE account_id = ?
          AND (? = 1 OR (status = 'active' AND (expires_at IS NULL OR expires_at > ?)))
        ORDER BY created_at DESC`)
      .bind(
        accountId,
        options.includeInactive ? 1 : 0,
        options.now.toISOString(),
      )
      .all<D1PersonalAccessTokenRow>();

    return result.results.map((row) => {
      const token = mapScopes(row, "scopes_json", "scopes");
      return token.status === "active" &&
        token.expires_at !== null &&
        Date.parse(token.expires_at) <= options.now.getTime()
        ? { ...token, status: "expired" as const }
        : token;
    });
  }

  async revokePersonalAccessToken(
    id: StoredPersonalAccessToken["id"],
    accountId: StoredAccount["id"],
    revokedAt: string,
  ): Promise<StoredPersonalAccessToken | null> {
    await this.db
      .prepare(`UPDATE personal_access_tokens
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND account_id = ?`)
      .bind(revokedAt, id, accountId)
      .run();
    return this.findPersonalAccessTokenById(id).then((token) =>
      token?.account_id === accountId ? token : null,
    );
  }

  async createPatIdempotencyRecord(record: StoredPatIdempotencyRecord) {
    await this.db
      .prepare(`INSERT INTO pat_idempotency_records (
        id, account_id, idempotency_key, request_hash, token_id, created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        ...values(record, [
          "id",
          "account_id",
          "idempotency_key",
          "request_hash",
          "token_id",
          "created_at",
          "expires_at",
        ]),
      )
      .run();
  }

  async findPatIdempotencyRecord(
    accountId: StoredAccount["id"],
    idempotencyKey: string,
    now?: Date,
  ) {
    return this.first<StoredPatIdempotencyRecord>(
      `SELECT * FROM pat_idempotency_records
        WHERE account_id = ? AND idempotency_key = ?
          AND (? IS NULL OR expires_at > ?)`,
      accountId,
      idempotencyKey,
      now?.toISOString() ?? null,
      now?.toISOString() ?? null,
    );
  }

  async createPersonalAccessTokenIdempotently(
    token: StoredPersonalAccessToken,
    idempotency: StoredPatIdempotencyRecord,
  ): Promise<"created" | "existing"> {
    const deleteExpiredStatement = this.db
      .prepare(`DELETE FROM pat_idempotency_records
        WHERE expires_at <= ?`)
      .bind(idempotency.created_at);
    const tokenStatement = this.db
      .prepare(`INSERT INTO personal_access_tokens (
        id, account_id, name, token_hash, status, scopes_json, created_at,
        expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        token.id,
        token.account_id,
        token.name,
        token.token_hash,
        token.status,
        JSON.stringify(token.scopes),
        token.created_at,
        token.expires_at,
        token.last_used_at,
        token.revoked_at,
      );
    const idempotencyStatement = this.db
      .prepare(`INSERT INTO pat_idempotency_records (
        id, account_id, idempotency_key, request_hash, token_id, created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        idempotency.id,
        idempotency.account_id,
        idempotency.idempotency_key,
        idempotency.request_hash,
        idempotency.token_id,
        idempotency.created_at,
        idempotency.expires_at,
      );

    try {
      await this.db.batch([
        deleteExpiredStatement,
        tokenStatement,
        idempotencyStatement,
      ]);
      return "created";
    } catch (error) {
      const existing = await this.findPatIdempotencyRecord(
        idempotency.account_id,
        idempotency.idempotency_key,
        new Date(idempotency.created_at),
      );

      if (existing !== null) return "existing";
      throw error;
    }
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

  private async findDeviceAuthorizationById(
    id: StoredDeviceAuthorization["id"],
  ) {
    const row = await this.first<D1DeviceAuthorizationRow>(
      "SELECT * FROM device_authorizations WHERE id = ?",
      id,
    );
    return row === null
      ? null
      : mapScopes(row, "requested_scopes_json", "requested_scopes");
  }

  private async findDeviceAuthorizationByIdAndStatus(
    id: StoredDeviceAuthorization["id"],
    status: StoredDeviceAuthorization["status"],
  ) {
    const authorization = await this.findDeviceAuthorizationById(id);
    return authorization?.status === status ? authorization : null;
  }
}

function values<T extends object>(record: T, keys: (keyof T)[]): unknown[] {
  return keys.map((key) => record[key]);
}

function mapScopes<
  T extends { [key: string]: unknown },
  JsonKey extends keyof T,
  ScopeKey extends string,
>(record: T, jsonKey: JsonKey, scopeKey: ScopeKey) {
  const { [jsonKey]: scopesJson, ...rest } = record;
  return {
    ...rest,
    [scopeKey]: JSON.parse(scopesJson as string),
  } as Omit<T, JsonKey> & { [K in ScopeKey]: StoredCliSession["scopes"] };
}
