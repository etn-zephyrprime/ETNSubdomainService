CREATE TABLE IF NOT EXISTS bubblemap_tokens (
  token_address TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  decimals INTEGER NOT NULL DEFAULT 18,
  total_supply TEXT,
  exchange_rate NUMERIC,
  price_checked_at TIMESTAMPTZ,
  launch_block BIGINT,
  launch_timestamp TIMESTAMPTZ,
  launch_checked_at TIMESTAMPTZ,
  holders_cursor JSONB,
  holders_fetched_count INTEGER NOT NULL DEFAULT 0,
  holders_refresh_started_at TIMESTAMPTZ,
  holders_refreshed_at TIMESTAMPTZ,
  transfer_cursor JSONB,
  transfer_poll_cursor JSONB,
  transfer_poll_started_block BIGINT,
  transfer_polled_at TIMESTAMPTZ,
  transfer_backfill_complete BOOLEAN NOT NULL DEFAULT false,
  last_processed_block BIGINT NOT NULL DEFAULT 0,
  analysis_dirty BOOLEAN NOT NULL DEFAULT true,
  map_json JSONB,
  map_updated_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bubblemap_token_holders (
  token_address TEXT NOT NULL REFERENCES bubblemap_tokens(token_address) ON DELETE CASCADE,
  holder_address TEXT NOT NULL,
  balance TEXT NOT NULL,
  is_contract BOOLEAN,
  address_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_address, holder_address)
);

CREATE INDEX IF NOT EXISTS bubblemap_token_holders_by_address
  ON bubblemap_token_holders(holder_address);

CREATE TABLE IF NOT EXISTS bubblemap_token_transfers (
  token_address TEXT NOT NULL REFERENCES bubblemap_tokens(token_address) ON DELETE CASCADE,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  block_number BIGINT NOT NULL,
  transfer_timestamp TIMESTAMPTZ,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value TEXT NOT NULL,
  token_type TEXT,
  has_nft BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (token_address, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS bubblemap_token_transfers_by_token_block
  ON bubblemap_token_transfers(token_address, block_number DESC);

CREATE INDEX IF NOT EXISTS bubblemap_token_transfers_by_participants
  ON bubblemap_token_transfers(from_address, to_address);

CREATE TABLE IF NOT EXISTS bubblemap_addresses (
  address TEXT PRIMARY KEY,
  is_contract BOOLEAN,
  name TEXT,
  ens_domain_name TEXT,
  public_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  private_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_funder TEXT,
  first_funder_candidate TEXT,
  first_funder_candidate_block BIGINT,
  first_funder_complete BOOLEAN NOT NULL DEFAULT false,
  tx_cursor JSONB,
  tx_pages_scanned INTEGER NOT NULL DEFAULT 0,
  tx_scan_complete BOOLEAN NOT NULL DEFAULT false,
  degree INTEGER NOT NULL DEFAULT 0,
  degree_complete BOOLEAN NOT NULL DEFAULT false,
  scan_level SMALLINT NOT NULL DEFAULT 0,
  metadata_fetched_at TIMESTAMPTZ,
  scan_requested BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bubblemap_addresses_scan_queue
  ON bubblemap_addresses(scan_requested, metadata_fetched_at, tx_scan_complete);

CREATE TABLE IF NOT EXISTS bubblemap_address_counterparties (
  address TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (address, counterparty),
  CHECK (address <> counterparty)
);

CREATE INDEX IF NOT EXISTS bubblemap_counterparties_by_address
  ON bubblemap_address_counterparties(address);

CREATE TABLE IF NOT EXISTS bubblemap_native_transfers (
  transaction_hash TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL,
  transfer_timestamp TIMESTAMPTZ,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value TEXT NOT NULL,
  has_nft BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS bubblemap_native_transfers_by_participants
  ON bubblemap_native_transfers(from_address, to_address);

CREATE TABLE IF NOT EXISTS bubblemap_admin_overrides (
  address TEXT PRIMARY KEY,
  override_type TEXT NOT NULL CHECK (override_type IN ('hub', 'not_hub', 'entity', 'ignore', 'include')),
  label TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bubblemap_worker_state (
  state_key TEXT PRIMARY KEY,
  state_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
