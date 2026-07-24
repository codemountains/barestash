CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  primary_email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_subject),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_identities_account ON identities(account_id);

-- Maps Better Auth browser users to Barestash domain accounts. Better Auth's
-- adapter-owned tables are intentionally deployed by the web worker later.
CREATE TABLE better_auth_account_mappings (
  id TEXT PRIMARY KEY,
  better_auth_user_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  account_id TEXT,
  client_name TEXT NOT NULL,
  client_version TEXT,
  device_name TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'denied', 'consumed', 'expired')
  ),
  requested_scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds > 0),
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_device_authorizations_status_expires
ON device_authorizations(status, expires_at);

CREATE TABLE cli_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_name TEXT,
  client_version TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'revoked', 'compromised', 'expired')
  ),
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  compromised_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_cli_sessions_account_status
ON cli_sessions(account_id, status, created_at DESC);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (session_id) REFERENCES cli_sessions(id)
);

CREATE INDEX idx_access_tokens_session_status
ON access_tokens(session_id, status, expires_at);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_family_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  parent_token_id TEXT,
  replaced_by_token_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (session_id) REFERENCES cli_sessions(id),
  FOREIGN KEY (parent_token_id) REFERENCES refresh_tokens(id),
  FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id)
);

CREATE INDEX idx_refresh_tokens_session_status
ON refresh_tokens(session_id, status, expires_at);
CREATE INDEX idx_refresh_tokens_family
ON refresh_tokens(token_family_id, status);

CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE(account_id, id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_personal_access_tokens_account_status_created
ON personal_access_tokens(account_id, status, created_at DESC);

CREATE TABLE pat_idempotency_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (account_id, token_id)
    REFERENCES personal_access_tokens(account_id, id)
);

CREATE INDEX idx_pat_idempotency_records_expires
ON pat_idempotency_records(expires_at);
