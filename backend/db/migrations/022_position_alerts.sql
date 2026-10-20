-- Core tier premium feature: position health alerts — Telegram DMs about a member's liquidity and
-- farm positions across ALL their covered wallets (same owner scope as portfolio_alerts):
--
--   il_threshold     — a V2 LP / V3 / farm position's impermanent loss (services/impermanentLoss.js)
--                      reaches -threshold_pct. Re-arms once it recovers 2 points (to
--                      -(threshold_pct - 2)), so it can fire again — recurring, never one-shot.
--   v3_out_of_range  — a directly-held V3 position leaves its price range (and a note when it's back).
--   farm_multiplier  — a yield-farm position's duration multiplier passes a milestone (1.25x, 1.5x,
--                      ... 2.5x max).
--
-- One row per (owner, alert_type): it covers every matching position. position_state holds the
-- per-position memory each type needs, keyed by a stable position key (positionAlertScheduler.js):
--   il_threshold    -> { "<key>": { "armed": bool } }
--   v3_out_of_range -> { "<key>": { "inRange": bool } }
--   farm_multiplier -> { "<key>": { "milestone": number } }
-- A position seen for the first time is recorded, and only alerted if it's already past the line
-- (IL beyond the threshold, or out of range); farm milestones already passed are recorded silently.
CREATE TABLE IF NOT EXISTS position_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('il_threshold', 'v3_out_of_range', 'farm_multiplier')),
  threshold_pct NUMERIC CHECK (threshold_pct IS NULL OR threshold_pct > 0),
  position_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ,
  CHECK ((alert_type = 'il_threshold') = (threshold_pct IS NOT NULL)),
  UNIQUE (owner_wallet, alert_type)
);

CREATE INDEX IF NOT EXISTS position_alerts_active_idx ON position_alerts (owner_wallet) WHERE active;
