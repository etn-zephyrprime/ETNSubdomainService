-- Core tier premium feature: portfolio-level alerts — a %-move alert on a member's COMBINED
-- tracked-wallet USD value (see portfolioValuation.js), plus an opt-in daily summary DM. Distinct
-- from wallet_alerts (009_alerts.sql), which is scoped to one tracked wallet at a time; these are
-- scoped to the OWNER (all their currently-tracked wallets together), so there's no wallet_address
-- column — just owner_wallet, same identity every other premium feature already authenticates
-- against.
--
-- Recurring, not one-shot (same confirmed decision as token_price_alerts): baseline_usd resets to
-- the value that just triggered it, alert stays active.
CREATE TABLE IF NOT EXISTS portfolio_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  threshold_pct NUMERIC NOT NULL CHECK (threshold_pct > 0),
  baseline_usd NUMERIC NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS portfolio_alerts_active_idx ON portfolio_alerts (owner_wallet) WHERE active;

-- One row per member who has opted in to the daily portfolio summary DM (portfolioDigestScheduler.js).
-- last_sent_total_usd is what the NEXT day's digest diffs against — the digest reports "since
-- yesterday's digest", not "since midnight" or any other fixed window, so a member who enables
-- this mid-day gets a sensible first comparison once the second digest goes out, and a missed day
-- (scheduler down, member briefly unlinked) just compares against whenever the last one actually
-- was rather than silently corrupting the trend.
CREATE TABLE IF NOT EXISTS portfolio_digest_subscriptions (
  owner_wallet TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_sent_date DATE,
  last_sent_total_usd NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
