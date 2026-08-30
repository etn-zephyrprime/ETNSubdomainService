-- Premium Feature #1 (per-wallet PnL statements) — initial schema.
-- Applied via backend/scripts/runMigrations.js, never by hand.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- Read-through cache of PremiumSubscription.membershipExpiry — the contract remains the source of
-- truth; this exists so request handling doesn't need a live eth_call on every read. Kept current
-- by backend/utils/premiumSubscriptionWatcher.js.
CREATE TABLE IF NOT EXISTS premium_memberships (
  wallet_address TEXT PRIMARY KEY,
  expiry_timestamp TIMESTAMPTZ NOT NULL,
  last_tx_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per purchased PnL statement period. Created only from a confirmed on-chain
-- PnlPeriodsPurchased event (never from a client claim) — see premiumSubscriptionWatcher.js.
CREATE TABLE IF NOT EXISTS statement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash TEXT NOT NULL,
  period_index INTEGER NOT NULL,
  tracked_wallet TEXT NOT NULL,
  payer_wallet TEXT NOT NULL,
  amount_paid_wei NUMERIC(78, 0) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PAID'
    CHECK (status IN ('PAID', 'PENDING_GENERATION', 'GENERATED', 'FINALIZED', 'REFUNDED')),
  year_end_mark_date DATE,
  self_owned_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ,
  first_viewed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_tx_hash TEXT,
  artifact_pdf_key TEXT,
  artifact_json_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, period_index)
);
CREATE INDEX IF NOT EXISTS idx_statement_requests_tracked_wallet ON statement_requests (tracked_wallet);
CREATE INDEX IF NOT EXISTS idx_statement_requests_status ON statement_requests (status);

-- Per-wallet ingestion cursor — the relational analogue of nftSalesState.js's dual-cursor shape,
-- now keyed per wallet instead of one global object.
CREATE TABLE IF NOT EXISTS wallet_ingestion_state (
  tracked_wallet TEXT PRIMARY KEY,
  last_ingested_block BIGINT NOT NULL DEFAULT 0,
  cold_start_completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw on-chain transfers (native ETN + tokens) affecting a tracked wallet, plus gas paid by it.
-- Dedup key mirrors nftSalesCache.js's composite-key pattern, adapted to transfers.
CREATE TABLE IF NOT EXISTS ingested_transfers (
  id BIGSERIAL PRIMARY KEY,
  tracked_wallet TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT -1, -- -1 for a plain top-level/internal native transfer (no log)
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  counterparty_address TEXT NOT NULL,
  is_self_transfer BOOLEAN NOT NULL DEFAULT false,
  is_cex BOOLEAN NOT NULL DEFAULT false,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('native', 'erc20')),
  token_address TEXT, -- null for native
  amount_raw NUMERIC(78, 0) NOT NULL,
  amount_decimal NUMERIC NOT NULL,
  price_usd_at_time NUMERIC,
  usd_value NUMERIC,
  gas_fee_wei NUMERIC(78, 0), -- only set on the row where tracked_wallet is the sender of the tx itself
  block_number BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tracked_wallet, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_ingested_transfers_wallet_time ON ingested_transfers (tracked_wallet, "timestamp");

-- ElectroSwap trades a tracked wallet participated in — decoded from Swap events and split into a
-- disposal (sold leg) + acquisition (bought leg) rather than treated as a generic transfer.
CREATE TABLE IF NOT EXISTS swap_trades (
  id BIGSERIAL PRIMARY KEY,
  tracked_wallet TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  token_sold_address TEXT NOT NULL, -- 'NATIVE' sentinel for ETN
  amount_sold NUMERIC NOT NULL,
  token_bought_address TEXT NOT NULL,
  amount_bought NUMERIC NOT NULL,
  price_usd_sold_leg NUMERIC,
  price_usd_bought_leg NUMERIC,
  block_number BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tracked_wallet, tx_hash, log_index)
);

-- NOTE on FIFO lots / realized PnL: deliberately NOT modeled as their own persistent,
-- continuously-mutated tables. A statement must be a frozen, point-in-time snapshot as of its own
-- period's end date (see the build brief's "statement freeze" requirement) — but ingestion pulls
-- a wallet's FULL history up to "now" on every request, which could be well after an
-- already-purchased future period's end date. A live-mutated ledger table would drift ahead of
-- whatever date a given statement is actually supposed to represent. Instead,
-- pnlStatementGenerator.js computes each period's opening/closing inventory and realized PnL via
-- a bounded, in-memory replay (fifoLotEngine.js's replayFifo()) over ingested_transfers/
-- swap_trades up to that specific period's end timestamp, and writes the full result straight into
-- the frozen JSON artifact (R2) rather than a separate, ambiguously-timed database table. Postgres
-- here only ever stores the raw source data (ingested_transfers/swap_trades below) plus the
-- request/pricing/logging tables — never derived FIFO state.

-- Small, manually-maintained list of known CEX hot-wallet addresses (Blockscout has no address
-- tagging for these on Electroneum — confirmed). Deliberately separate from a request's own
-- self_owned_addresses.
CREATE TABLE IF NOT EXISTS cex_addresses (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cache in front of the live price source (GeckoTerminal/CoinGecko) — see pnlPricing.js.
CREATE TABLE IF NOT EXISTS price_points (
  id BIGSERIAL PRIMARY KEY,
  asset TEXT NOT NULL, -- 'ETN' or a token address
  "timestamp" TIMESTAMPTZ NOT NULL,
  price_usd NUMERIC NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset, "timestamp")
);

-- Transparency log for every executed buy-and-burn split — one row per FINALIZED request that had
-- a non-zero amount to split.
CREATE TABLE IF NOT EXISTS buy_and_burn_log (
  id BIGSERIAL PRIMARY KEY,
  statement_request_id UUID NOT NULL REFERENCES statement_requests (id),
  split_wallet_amount_wei NUMERIC(78, 0) NOT NULL,
  swap_and_burn_tx_hash TEXT NOT NULL,
  eth_swapped_wei NUMERIC(78, 0) NOT NULL,
  core_received NUMERIC NOT NULL,
  core_burned NUMERIC NOT NULL,
  operator_address TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (statement_request_id)
);
