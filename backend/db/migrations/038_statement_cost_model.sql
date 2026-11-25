-- Per-request cost-basis method: 'fifo' (default, all existing rows) or 'pooled' (average cost /
-- Section 104 pooling, see services/pooledCostEngine.js). Chosen before payment via
-- statement_order_intents below, then copied onto the statement_requests row when the purchase
-- event is confirmed on-chain.
ALTER TABLE statement_requests
  ADD COLUMN IF NOT EXISTS cost_model TEXT NOT NULL DEFAULT 'fifo'
  CHECK (cost_model IN ('fifo', 'pooled'));

-- A signed record, made before the purchase transaction, of which cost-basis method a payer wants
-- for one (tracked wallet, period). The on-chain PnlPeriodPurchased event has no field for this,
-- so the watcher matches the most recent unconsumed, unexpired intent for the same
-- (payer, tracked wallet, period_type, year) when it creates the statement request.
CREATE TABLE IF NOT EXISTS statement_order_intents (
  id BIGSERIAL PRIMARY KEY,
  payer_wallet TEXT NOT NULL,
  tracked_wallet TEXT NOT NULL,
  period_type SMALLINT NOT NULL,
  year INTEGER NOT NULL,
  cost_model TEXT NOT NULL CHECK (cost_model IN ('fifo', 'pooled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS statement_order_intents_lookup
  ON statement_order_intents (payer_wallet, tracked_wallet, period_type, year, created_at DESC)
  WHERE consumed_at IS NULL;
