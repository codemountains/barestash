-- Prepare domain accounts before the scoped-PAT Worker is deployed. Legacy
-- credentials remain usable by the old Worker until the post-deploy cutover
-- finalizer runs; their secrets are never copied into personal_access_tokens.
INSERT OR IGNORE INTO accounts (
  id, primary_email, display_name, avatar_url, status, created_at, updated_at
)
SELECT DISTINCT
  account_id, NULL, NULL, NULL, 'active', created_at, created_at
FROM tokens;

-- Transitional bootstrap PAT issuance continues to use the MVP account until
-- Device Authorization provisioning is available.
INSERT OR IGNORE INTO accounts (
  id, primary_email, display_name, avatar_url, status, created_at, updated_at
) VALUES (
  'acct_mvp', NULL, NULL, NULL, 'active',
  '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
);
