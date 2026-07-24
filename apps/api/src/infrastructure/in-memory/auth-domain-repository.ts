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

/** @public */
export class InMemoryAuthDomainRepository implements AuthDomainRepository {
  readonly #accounts = new Map<string, StoredAccount>();
  readonly #identities = new Map<string, StoredIdentity>();
  readonly #browserMappings = new Map<string, StoredBrowserAccountMapping>();
  readonly #deviceAuthorizations = new Map<string, StoredDeviceAuthorization>();
  readonly #cliSessions = new Map<string, StoredCliSession>();
  readonly #accessTokens = new Map<string, StoredAccessToken>();
  readonly #refreshTokens = new Map<string, StoredRefreshToken>();
  readonly #personalAccessTokens = new Map<string, StoredPersonalAccessToken>();
  readonly #patIdempotencyRecords = new Map<
    string,
    StoredPatIdempotencyRecord
  >();

  async createAccount(record: StoredAccount): Promise<void> {
    assertUnique(
      this.#accounts,
      (candidate) => candidate.id === record.id,
      "accounts.id",
    );
    this.#accounts.set(record.id, structuredClone(record));
  }

  async createAccountIfAbsent(record: StoredAccount): Promise<void> {
    if (!this.#accounts.has(record.id)) await this.createAccount(record);
  }

  async findAccountById(id: StoredAccount["id"]) {
    return clone(this.#accounts.get(id));
  }

  async createIdentity(record: StoredIdentity): Promise<void> {
    assertForeignKey(this.#accounts.has(record.account_id));
    assertUnique(
      this.#identities,
      (candidate) => candidate.id === record.id,
      "identities.id",
    );
    assertUnique(
      this.#identities,
      (candidate) =>
        candidate.provider === record.provider &&
        candidate.provider_subject === record.provider_subject,
      "identities.provider, identities.provider_subject",
    );
    this.#identities.set(record.id, structuredClone(record));
  }

  async findIdentityByProvider(
    provider: IdentityProvider,
    providerSubject: string,
  ) {
    return clone(
      findValue(
        this.#identities,
        (candidate) =>
          candidate.provider === provider &&
          candidate.provider_subject === providerSubject,
      ),
    );
  }

  async createBrowserAccountMapping(
    record: StoredBrowserAccountMapping,
  ): Promise<void> {
    assertForeignKey(this.#accounts.has(record.account_id));
    assertUnique(
      this.#browserMappings,
      (candidate) => candidate.id === record.id,
      "better_auth_account_mappings.id",
    );
    assertUnique(
      this.#browserMappings,
      (candidate) =>
        candidate.better_auth_user_id === record.better_auth_user_id,
      "better_auth_account_mappings.better_auth_user_id",
    );
    assertUnique(
      this.#browserMappings,
      (candidate) => candidate.account_id === record.account_id,
      "better_auth_account_mappings.account_id",
    );
    this.#browserMappings.set(record.id, structuredClone(record));
  }

  async findBrowserAccountMappingByBetterAuthUserId(betterAuthUserId: string) {
    return clone(
      findValue(
        this.#browserMappings,
        (candidate) => candidate.better_auth_user_id === betterAuthUserId,
      ),
    );
  }

  async createDeviceAuthorization(
    record: StoredDeviceAuthorization,
  ): Promise<"created" | "user_code_conflict"> {
    assertForeignKey(
      record.account_id === null || this.#accounts.has(record.account_id),
    );
    assertUnique(
      this.#deviceAuthorizations,
      (candidate) => candidate.id === record.id,
      "device_authorizations.id",
    );
    assertUnique(
      this.#deviceAuthorizations,
      (candidate) => candidate.device_code_hash === record.device_code_hash,
      "device_authorizations.device_code_hash",
    );
    if (
      findValue(
        this.#deviceAuthorizations,
        (candidate) => candidate.user_code_hash === record.user_code_hash,
      ) !== undefined
    ) {
      return "user_code_conflict";
    }
    this.#deviceAuthorizations.set(record.id, structuredClone(record));
    return "created";
  }

  async findDeviceAuthorizationByDeviceCodeHash(deviceCodeHash: string) {
    return clone(
      findValue(
        this.#deviceAuthorizations,
        (candidate) => candidate.device_code_hash === deviceCodeHash,
      ),
    );
  }

  async findDeviceAuthorizationByUserCodeHash(userCodeHash: string) {
    return clone(
      findValue(
        this.#deviceAuthorizations,
        (candidate) => candidate.user_code_hash === userCodeHash,
      ),
    );
  }

  async recordDeviceAuthorizationPoll(
    id: StoredDeviceAuthorization["id"],
    polledAt: string,
    allowedBefore: string,
  ): Promise<boolean> {
    const authorization = this.#deviceAuthorizations.get(id);
    if (
      authorization === undefined ||
      (authorization.last_polled_at !== null &&
        authorization.last_polled_at > allowedBefore)
    ) {
      return false;
    }
    this.#deviceAuthorizations.set(id, {
      ...authorization,
      last_polled_at: polledAt,
    });
    return true;
  }

  async approveDeviceAuthorization(
    id: StoredDeviceAuthorization["id"],
    accountId: StoredAccount["id"],
    approvedAt: string,
  ) {
    const authorization = this.#deviceAuthorizations.get(id);
    if (
      authorization === undefined ||
      authorization.status !== "pending" ||
      authorization.expires_at <= approvedAt ||
      !this.#accounts.has(accountId)
    ) {
      return null;
    }
    const approved: StoredDeviceAuthorization = {
      ...authorization,
      account_id: accountId,
      status: "approved",
      approved_at: approvedAt,
    };
    this.#deviceAuthorizations.set(id, approved);
    return structuredClone(approved);
  }

  async denyDeviceAuthorization(
    id: StoredDeviceAuthorization["id"],
    deniedAt: string,
  ) {
    const authorization = this.#deviceAuthorizations.get(id);
    if (
      authorization === undefined ||
      authorization.status !== "pending" ||
      authorization.expires_at <= deniedAt
    ) {
      return null;
    }
    const denied: StoredDeviceAuthorization = {
      ...authorization,
      status: "denied",
      denied_at: deniedAt,
    };
    this.#deviceAuthorizations.set(id, denied);
    return structuredClone(denied);
  }

  async expireDeviceAuthorization(id: StoredDeviceAuthorization["id"]) {
    const authorization = this.#deviceAuthorizations.get(id);
    if (authorization === undefined || authorization.status !== "pending") {
      return null;
    }
    const expired: StoredDeviceAuthorization = {
      ...authorization,
      status: "expired",
    };
    this.#deviceAuthorizations.set(id, expired);
    return structuredClone(expired);
  }

  async exchangeDeviceAuthorization(
    authorizationId: StoredDeviceAuthorization["id"],
    session: StoredCliSession,
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    consumedAt: string,
  ): Promise<DeviceAuthorizationExchangeResult> {
    const authorization = this.#deviceAuthorizations.get(authorizationId);
    if (
      authorization === undefined ||
      authorization.status !== "approved" ||
      authorization.account_id !== session.account_id ||
      authorization.expires_at <= consumedAt
    ) {
      return "authorization_unavailable";
    }
    const account = this.#accounts.get(session.account_id);
    if (account === undefined || account.status === "disabled") {
      return "account_disabled";
    }
    await this.createCliSession(session);
    await this.createAccessToken(accessToken);
    await this.createRefreshToken(refreshToken);
    this.#deviceAuthorizations.set(authorizationId, {
      ...authorization,
      status: "consumed",
      consumed_at: consumedAt,
    });
    return "exchanged";
  }

  async createCliSession(record: StoredCliSession): Promise<void> {
    assertForeignKey(this.#accounts.has(record.account_id));
    assertUnique(
      this.#cliSessions,
      (candidate) => candidate.id === record.id,
      "cli_sessions.id",
    );
    this.#cliSessions.set(record.id, structuredClone(record));
  }

  async findCliSessionById(id: StoredCliSession["id"]) {
    return clone(this.#cliSessions.get(id));
  }

  async updateCliSessionLastUsed(
    id: StoredCliSession["id"],
    lastUsedAt: string,
  ): Promise<void> {
    updateRecord(this.#cliSessions, id, { last_used_at: lastUsedAt });
  }

  async createAccessToken(record: StoredAccessToken): Promise<void> {
    assertForeignKey(this.#cliSessions.has(record.session_id));
    assertUnique(
      this.#accessTokens,
      (candidate) => candidate.id === record.id,
      "access_tokens.id",
    );
    assertUnique(
      this.#accessTokens,
      (candidate) => candidate.token_hash === record.token_hash,
      "access_tokens.token_hash",
    );
    this.#accessTokens.set(record.id, structuredClone(record));
  }

  async findAccessTokenById(id: StoredAccessToken["id"]) {
    return clone(this.#accessTokens.get(id));
  }

  async updateAccessTokenLastUsed(
    id: StoredAccessToken["id"],
    lastUsedAt: string,
  ): Promise<void> {
    updateRecord(this.#accessTokens, id, { last_used_at: lastUsedAt });
  }

  async createRefreshToken(record: StoredRefreshToken): Promise<void> {
    assertForeignKey(this.#cliSessions.has(record.session_id));
    assertForeignKey(
      record.parent_token_id === null ||
        this.#refreshTokens.has(record.parent_token_id),
    );
    assertForeignKey(
      record.replaced_by_token_id === null ||
        this.#refreshTokens.has(record.replaced_by_token_id),
    );
    assertUnique(
      this.#refreshTokens,
      (candidate) => candidate.id === record.id,
      "refresh_tokens.id",
    );
    assertUnique(
      this.#refreshTokens,
      (candidate) => candidate.token_hash === record.token_hash,
      "refresh_tokens.token_hash",
    );
    this.#refreshTokens.set(record.id, structuredClone(record));
  }

  async findRefreshTokenById(id: StoredRefreshToken["id"]) {
    return clone(this.#refreshTokens.get(id));
  }

  async rotateRefreshToken(
    currentTokenId: StoredRefreshToken["id"],
    accessToken: StoredAccessToken,
    refreshToken: StoredRefreshToken,
    lastUsedAt: string,
    idleExpiresAt: string,
  ) {
    const current = this.#refreshTokens.get(currentTokenId);
    if (current === undefined) return "session_unavailable" as const;
    if (current.status === "used") {
      await this.compromiseCliSession(
        current.session_id,
        current.token_family_id,
        lastUsedAt,
      );
      return "reuse_detected" as const;
    }
    if (current.status !== "active") return "session_unavailable" as const;
    const session = this.#cliSessions.get(current.session_id);
    if (session === undefined || session.status !== "active") {
      return "session_unavailable" as const;
    }
    if (
      session.idle_expires_at <= lastUsedAt ||
      session.absolute_expires_at <= lastUsedAt
    ) {
      return "session_expired" as const;
    }
    if (this.#accounts.get(session.account_id)?.status !== "active") {
      return "account_disabled" as const;
    }
    this.#refreshTokens.set(current.id, {
      ...current,
      status: "used",
      used_at: lastUsedAt,
      replaced_by_token_id: refreshToken.id,
    });
    this.#accessTokens.set(accessToken.id, structuredClone(accessToken));
    this.#refreshTokens.set(refreshToken.id, structuredClone(refreshToken));
    this.#cliSessions.set(session.id, {
      ...session,
      last_used_at: lastUsedAt,
      idle_expires_at: idleExpiresAt,
    });
    return "rotated" as const;
  }

  async compromiseCliSession(
    sessionId: StoredCliSession["id"],
    tokenFamilyId: string,
    compromisedAt: string,
  ): Promise<void> {
    const session = this.#cliSessions.get(sessionId);
    if (session !== undefined) {
      this.#cliSessions.set(sessionId, {
        ...session,
        status: "compromised",
        compromised_at: session.compromised_at ?? compromisedAt,
      });
    }
    for (const [id, token] of this.#accessTokens) {
      if (token.session_id === sessionId && token.status !== "revoked") {
        this.#accessTokens.set(id, {
          ...token,
          status: "revoked",
          revoked_at: compromisedAt,
        });
      }
    }
    for (const [id, token] of this.#refreshTokens) {
      if (
        token.token_family_id === tokenFamilyId &&
        token.status !== "revoked"
      ) {
        this.#refreshTokens.set(id, {
          ...token,
          status: "revoked",
          revoked_at: compromisedAt,
        });
      }
    }
  }

  async revokeCliSession(sessionId: StoredCliSession["id"], revokedAt: string) {
    const session = this.#cliSessions.get(sessionId);
    if (session === undefined) return null;
    const effectiveRevokedAt = session.revoked_at ?? revokedAt;
    const revoked: StoredCliSession = {
      ...session,
      status: "revoked",
      revoked_at: effectiveRevokedAt,
    };
    this.#cliSessions.set(sessionId, revoked);
    for (const [id, token] of this.#accessTokens) {
      if (token.session_id === sessionId && token.status !== "revoked") {
        this.#accessTokens.set(id, {
          ...token,
          status: "revoked",
          revoked_at: effectiveRevokedAt,
        });
      }
    }
    for (const [id, token] of this.#refreshTokens) {
      if (token.session_id === sessionId && token.status !== "revoked") {
        this.#refreshTokens.set(id, {
          ...token,
          status: "revoked",
          revoked_at: effectiveRevokedAt,
        });
      }
    }
    return structuredClone(revoked);
  }

  async createPersonalAccessToken(
    record: StoredPersonalAccessToken,
  ): Promise<void> {
    assertForeignKey(this.#accounts.has(record.account_id));
    assertUnique(
      this.#personalAccessTokens,
      (candidate) => candidate.id === record.id,
      "personal_access_tokens.id",
    );
    assertUnique(
      this.#personalAccessTokens,
      (candidate) => candidate.token_hash === record.token_hash,
      "personal_access_tokens.token_hash",
    );
    this.#personalAccessTokens.set(record.id, structuredClone(record));
  }

  async findPersonalAccessTokenById(id: StoredPersonalAccessToken["id"]) {
    return clone(this.#personalAccessTokens.get(id));
  }

  async updatePersonalAccessTokenLastUsed(
    id: StoredPersonalAccessToken["id"],
    lastUsedAt: string,
  ): Promise<void> {
    updateRecord(this.#personalAccessTokens, id, {
      last_used_at: lastUsedAt,
    });
  }

  async listPersonalAccessTokens(
    accountId: StoredAccount["id"],
    options: { includeInactive: boolean; now: Date },
  ): Promise<StoredPersonalAccessToken[]> {
    return Array.from(this.#personalAccessTokens.values())
      .filter((token) => token.account_id === accountId)
      .map((token) => withEffectivePatStatus(token, options.now))
      .filter((token) => options.includeInactive || token.status === "active")
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((token) => structuredClone(token));
  }

  async revokePersonalAccessToken(
    id: StoredPersonalAccessToken["id"],
    accountId: StoredAccount["id"],
    revokedAt: string,
  ): Promise<StoredPersonalAccessToken | null> {
    const token = this.#personalAccessTokens.get(id);

    if (token === undefined || token.account_id !== accountId) return null;

    const revoked =
      token.status === "revoked"
        ? token
        : { ...token, status: "revoked" as const, revoked_at: revokedAt };
    this.#personalAccessTokens.set(id, structuredClone(revoked));
    return structuredClone(revoked);
  }

  async createPatIdempotencyRecord(
    record: StoredPatIdempotencyRecord,
  ): Promise<void> {
    const token = this.#personalAccessTokens.get(record.token_id);
    assertForeignKey(
      this.#accounts.has(record.account_id) &&
        token !== undefined &&
        token.account_id === record.account_id,
    );
    assertUnique(
      this.#patIdempotencyRecords,
      (candidate) => candidate.id === record.id,
      "pat_idempotency_records.id",
    );
    assertUnique(
      this.#patIdempotencyRecords,
      (candidate) =>
        candidate.account_id === record.account_id &&
        candidate.idempotency_key === record.idempotency_key,
      "pat_idempotency_records.account_id, pat_idempotency_records.idempotency_key",
    );
    this.#patIdempotencyRecords.set(record.id, structuredClone(record));
  }

  async findPatIdempotencyRecord(
    accountId: StoredAccount["id"],
    key: string,
    now?: Date,
  ) {
    return clone(
      findValue(
        this.#patIdempotencyRecords,
        (candidate) =>
          candidate.account_id === accountId &&
          candidate.idempotency_key === key &&
          (now === undefined ||
            Date.parse(candidate.expires_at) > now.getTime()),
      ),
    );
  }

  async createPersonalAccessTokenIdempotently(
    token: StoredPersonalAccessToken,
    idempotency: StoredPatIdempotencyRecord,
  ): Promise<"created" | "existing"> {
    const existing = findValue(
      this.#patIdempotencyRecords,
      (candidate) =>
        candidate.account_id === idempotency.account_id &&
        candidate.idempotency_key === idempotency.idempotency_key &&
        candidate.expires_at > idempotency.created_at,
    );

    if (existing !== undefined) return "existing";

    assertForeignKey(this.#accounts.has(token.account_id));
    assertUnique(
      this.#personalAccessTokens,
      (candidate) => candidate.id === token.id,
      "personal_access_tokens.id",
    );
    assertUnique(
      this.#personalAccessTokens,
      (candidate) => candidate.token_hash === token.token_hash,
      "personal_access_tokens.token_hash",
    );
    assertForeignKey(
      token.account_id === idempotency.account_id &&
        token.id === idempotency.token_id,
    );

    for (const [id, record] of this.#patIdempotencyRecords) {
      if (record.expires_at <= idempotency.created_at) {
        this.#patIdempotencyRecords.delete(id);
      }
    }

    assertUnique(
      this.#patIdempotencyRecords,
      (candidate) => candidate.id === idempotency.id,
      "pat_idempotency_records.id",
    );
    this.#personalAccessTokens.set(token.id, structuredClone(token));
    this.#patIdempotencyRecords.set(
      idempotency.id,
      structuredClone(idempotency),
    );
    return "created";
  }
}

function clone<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}

function findValue<T>(
  records: Map<string, T>,
  predicate: (record: T) => boolean,
): T | undefined {
  return Array.from(records.values()).find(predicate);
}

function assertUnique<T>(
  records: Map<string, T>,
  predicate: (record: T) => boolean,
  constraint: string,
): void {
  if (findValue(records, predicate) !== undefined) {
    throw new Error(`UNIQUE constraint failed: ${constraint}`);
  }
}

function assertForeignKey(valid: boolean): void {
  if (!valid) {
    throw new Error("FOREIGN KEY constraint failed");
  }
}

function updateRecord<T extends object>(
  records: Map<string, T>,
  id: string,
  update: Partial<T>,
): void {
  const record = records.get(id);

  if (record !== undefined) {
    records.set(id, structuredClone({ ...record, ...update }));
  }
}

function withEffectivePatStatus(
  token: StoredPersonalAccessToken,
  now: Date,
): StoredPersonalAccessToken {
  if (
    token.status === "active" &&
    token.expires_at !== null &&
    Date.parse(token.expires_at) <= now.getTime()
  ) {
    return { ...token, status: "expired" };
  }

  return token;
}
