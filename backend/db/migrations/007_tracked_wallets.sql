-- Core tier premium feature: multi-wallet tracking + combined portfolio (see
-- backend/utils/premiumDashboardRouter.js). Each member — identified by their own connected
-- wallet, proven via the same signed-ownership scheme GET /pnl/statements uses (walletAuth.js) —
-- can track up to MAX_TRACKED_WALLETS (3, enforced application-side in trackedWallets.js) wallets
-- for the combined portfolio view.
--
-- One row per add/remove CYCLE, not one row per member and not a single mutable list — this is
-- what makes the 30-day cooldowns enforceable at all: added_at is when a currently-tracked
-- wallet's hold period started (untracking too soon is blocked by checking it), and removed_at,
-- once set, is when a since-untracked wallet's re-track cooldown started (re-adding too soon is
-- blocked by checking the most recent row for that same owner+address pair). Without this history
-- — e.g. a flat "here's your current 3 addresses" list — there'd be nothing to check either
-- cooldown against: the whole point is to stop "untrack A, track B, untrack B, retrack A" from
-- being a free way to see more than 3 wallets' data over time.
--
-- removed_at IS NULL means still actively tracked. The partial unique index below guarantees at
-- most one active row per (owner_wallet, wallet_address) pair — re-tracking after a cooldown
-- creates a NEW row rather than reviving the old one, so the full add/remove history stays intact
-- for good.
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tracked_wallets_owner_idx ON tracked_wallets (owner_wallet);

CREATE UNIQUE INDEX IF NOT EXISTS tracked_wallets_active_unique
  ON tracked_wallets (owner_wallet, wallet_address)
  WHERE removed_at IS NULL;
