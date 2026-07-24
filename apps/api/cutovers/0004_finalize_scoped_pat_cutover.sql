-- Run only after the scoped-PAT Worker version is deployed. The new Worker
-- never authenticates through this table, and this idempotent update records
-- the completed legacy-credential cutover for operators and later cleanup.
UPDATE tokens
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, created_at)
WHERE status = 'active';
