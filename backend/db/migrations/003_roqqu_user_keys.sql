ALTER TABLE roqqu_connections
  ADD COLUMN IF NOT EXISTS api_key_ciphertext TEXT;

ALTER TABLE roqqu_connections
  DROP CONSTRAINT IF EXISTS roqqu_connections_provider_check;

ALTER TABLE roqqu_connections
  ADD CONSTRAINT roqqu_connections_provider_check
  CHECK (provider IN ('roqqu_ras', 'roqqu_api'));

CREATE TABLE IF NOT EXISTS roqqu_address_cache (
  symbol TEXT NOT NULL,
  address TEXT NOT NULL,
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, address)
);

CREATE TABLE IF NOT EXISTS roqqu_api_rate_limit (
  endpoint TEXT PRIMARY KEY,
  last_requested_at TIMESTAMPTZ NOT NULL
);