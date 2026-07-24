-- This pre-release migration intentionally invalidates credential formats that
-- cannot be verified with the required server-side pepper.
DELETE FROM endpoint_secrets
WHERE status != 'active'
AND NOT (
  length(secret_hash) = 76
  AND substr(secret_hash, 1, 12) = 'hmac-sha256$'
  AND substr(secret_hash, 13) NOT GLOB '*[^0-9a-f]*'
);

DELETE FROM tokens
WHERE NOT (
  length(token_hash) = 76
  AND substr(token_hash, 1, 12) = 'hmac-sha256$'
  AND substr(token_hash, 13) NOT GLOB '*[^0-9a-f]*'
);
