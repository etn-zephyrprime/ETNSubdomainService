-- Core tier premium feature: multi-wallet tracking + combined portfolio (see
-- backend/utils/premiumDashboardRouter.js). Each member — identified by their own connected
-- wallet, proven via the same signed-ownership scheme GET /pnl/statements uses (walletAuth.js) —
-- can track up to 3 wallets for the combined portfolio view. One row per member, not one row per
-- tracked wallet: the whole list is replaced together on every save (see
-- trackedWallets.setTrackedWallets), so there's no per-wallet lifecycle worth a separate row for.
-- MAX_TRACKED_WALLETS (3) is enforced application-side, not by a CHECK constraint, so it can
-- change without a migration.
CREATE TABLE IF NOT EXISTS tracked_wallets (
  owner_wallet TEXT PRIMARY KEY,
  wallets JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
