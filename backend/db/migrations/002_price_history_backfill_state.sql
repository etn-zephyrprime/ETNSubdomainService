-- Tracks which assets have had their full available on-chain price history bulk-backfilled into
-- price_points (see backend/services/pnlPricing.js's backfillAssetPriceHistory /
-- ensureBackfilled). One-time per asset, not re-run automatically — the whole point is turning
-- "one GeckoTerminal/CoinGecko call per transaction date" (rate-limit prone, confirmed live) into
-- "one bulk history fetch per asset, ever, then pure cache reads forever after."
CREATE TABLE IF NOT EXISTS price_history_backfill_state (
  asset TEXT PRIMARY KEY,
  earliest_available_date DATE, -- NULL if no pool/history was found at all for this asset
  pool_count INTEGER NOT NULL DEFAULT 0,
  backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
