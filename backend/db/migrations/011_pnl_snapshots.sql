-- Core tier premium feature: ongoing dashboard PnL (see pnlSnapshotService.js,
-- pnlSnapshotScheduler.js). Deliberately the SIMPLEST possible daily rollup — total value,
-- running realized P&L, running unrealized P&L, one row per (owner, tracked wallet, day) — never a
-- per-disposal ledger or anything resembling the PnL Statement product's frozen, itemized output.
-- This table only ever backs the value-over-time CHART; the "right now" figures shown alongside it
-- are always computed live (pnlSnapshotService.computeLivePnlSnapshot), never read from here — see
-- the build brief's explicit "this is not a record, not frozen" requirement.
--
-- Keyed by (owner_wallet, wallet_address, snapshot_date), not just (wallet_address, date): the
-- exact same wallet_alerts/token_price_alerts precedent applies here too — the same address can be
-- actively tracked by more than one different Core tier member independently, and each member's own
-- view of "my portfolio" must stay separate.
CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  total_value_usd NUMERIC NOT NULL,
  realized_pnl_usd NUMERIC NOT NULL,
  unrealized_pnl_usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pnl_snapshots_unique_day
  ON pnl_snapshots (owner_wallet, wallet_address, snapshot_date);

-- The chart's own read pattern: "every day for this owner's wallets, most recent first" (or a
-- capped window) — see pnlSnapshots.js.
CREATE INDEX IF NOT EXISTS pnl_snapshots_owner_date_idx ON pnl_snapshots (owner_wallet, snapshot_date DESC);
