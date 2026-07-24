CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  name TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  public_read INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  event_limit INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endpoints_mode_status_expires
ON endpoints(mode, status, expires_at);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL,
  received_at TEXT NOT NULL,

  method TEXT NOT NULL,
  ingest_path TEXT NOT NULL,
  request_path TEXT NOT NULL,
  query_json TEXT NOT NULL,
  allowlist_headers_json TEXT NOT NULL,
  sensitive_header_names_json TEXT NOT NULL,

  content_type TEXT,
  content_length INTEGER,
  user_agent TEXT,

  body_size INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_r2_key TEXT NOT NULL,
  request_r2_key TEXT NOT NULL,

  secret_verification_status TEXT NOT NULL,
  matched_secret_id TEXT,

  created_at TEXT NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_events_endpoint_received
ON events(endpoint_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_endpoint_sequence
ON events(endpoint_id, sequence);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token_hash
ON tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_tokens_account_status_created
ON tokens(account_id, status, created_at DESC);

CREATE TABLE endpoint_secrets (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_secrets_endpoint_status_created
ON endpoint_secrets(endpoint_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_secrets_secret_hash
ON endpoint_secrets(secret_hash);
