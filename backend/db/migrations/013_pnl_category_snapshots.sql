-- Core tier premium feature: per-category PnL history (see categoryPnlService.js,
-- pnlSnapshotScheduler.js) -- "Liquidity Positions" and "Staking / Yield Farms" charts, alongside
-- the existing whole-portfolio Value Over Time chart. Same "simplest possible daily rollup" design
-- as pnl_snapshots.sql (see that file's own comment) -- this is its sibling, not a replacement:
-- pnl_snapshots keeps tracking the whole portfolio total, this tracks the same three figures
-- (value/realized/unrealized) scoped to ONE category at a time, one row per (owner, tracked
-- wallet, category, day). Never a per-disposal ledger; the "right now" figures shown alongside
-- either chart are always computed live, never read from here.
--
-- `category` is a fixed short code, not a free-text label -- see categoryPnlService.js's own
-- CATEGORIES export for the exact set (currently 'liquidity', 'farm_staking').
--
-- Keyed by (owner_wallet, wallet_address, category, snapshot_date), not just (wallet_address,
-- category, date) -- same reasoning as pnl_snapshots.sql: the same address can be actively tracked
-- by more than one Core tier member independently, and each member's own view must stay separate.
CREATE TABLE IF NOT EXISTS pnl_category_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  category TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  total_value_usd NUMERIC NOT NULL,
  realized_pnl_usd NUMERIC NOT NULL,
  unrealized_pnl_usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pnl_category_snapshots_unique_day
  ON pnl_category_snapshots (owner_wallet, wallet_address, category, snapshot_date);

-- The chart's own read pattern: "every day for this owner's wallets and this one category, most
-- recent first" (or a capped window) -- see pnlCategorySnapshots.js.
CREATE INDEX IF NOT EXISTS pnl_category_snapshots_owner_category_date_idx
  ON pnl_category_snapshots (owner_wallet, category, snapshot_date DESC);
