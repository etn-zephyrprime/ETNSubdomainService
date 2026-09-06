-- Transparency log for subscriptionRevenueSweepScheduler.js — mirrors buy_and_burn_log's role for
-- PnL splits, but for membership-fee sweeps: one row per executed sweep of accumulated
-- subscription revenue on PlanetZephyrosPnLStatement. balance_at_sweep/pnl_owed_at_sweep are
-- recorded alongside the swept amount specifically so a later audit can verify the scheduler's own
-- arithmetic (swept = balance - owed - buffer) after the fact, not just trust that it ran.
CREATE TABLE IF NOT EXISTS subscription_revenue_sweeps (
  id BIGSERIAL PRIMARY KEY,
  amount_swept_wei NUMERIC(78, 0) NOT NULL,
  balance_at_sweep_wei NUMERIC(78, 0) NOT NULL,
  pnl_owed_at_sweep_wei NUMERIC(78, 0) NOT NULL,
  block_number BIGINT NOT NULL,
  swap_and_burn_tx_hash TEXT NOT NULL,
  core_received NUMERIC,
  core_burned NUMERIC,
  operator_address TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
