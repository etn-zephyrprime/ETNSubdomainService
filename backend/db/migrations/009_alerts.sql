-- Core tier premium feature: Telegram alerts (wallet balance/activity + token price moves) — see
-- backend/utils/walletAlertScheduler.js and backend/utils/tokenPriceAlertScheduler.js. Delivery
-- reuses the Telegram link already established by telegramLinkRouter.js/telegramLinkState.js (a
-- wallet -> chatId mapping keyed on the same address that's already every premium feature's
-- identity) — deliberately NO telegram_links table here: it would just duplicate that existing R2
-- mapping under a different name. A wallet already linked for marketplace sale-alerts is
-- automatically linked for these too.
--
-- wallet_alerts.wallet_address is stored directly (not a tracked_wallets.id FK) because
-- tracked_wallets is one row per add/remove CYCLE (see 007_tracked_wallets.sql) — a wallet
-- untracked and later re-tracked gets a brand-new row with a new id, which would silently orphan
-- any alert that referenced the old one. Storing the address directly and checking it against
-- getActiveTrackedWallets() at both creation and poll time (see walletAlertScheduler.js) is simpler
-- and can't go stale that way — an alert on a since-untracked wallet is just skipped, not broken.
CREATE TABLE IF NOT EXISTS wallet_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('balance_threshold', 'tx_activity')),
  -- balance_threshold only: 'above' or 'below'. NULL for tx_activity.
  direction TEXT CHECK (direction IN ('above', 'below')),
  -- balance_threshold: the crossing threshold, in `denomination` units. tx_activity: an optional
  -- minimum ETN value to notify on (NULL = any activity) — see tokenPriceAlertScheduler.js's own
  -- header comment on why a min amount can only ever be ETN-denominated for this alert type, not
  -- per-token.
  threshold_value NUMERIC,
  -- balance_threshold only: 'ETN' or a token contract address (lowercased). NULL for tx_activity.
  denomination TEXT,
  -- Crossing-detection state for balance_threshold — 'above'/'below' as of the last poll, so a
  -- notification only fires on a TRANSITION (never re-fires while the balance stays on the same
  -- side of the threshold) and fires again naturally once it crosses back and forth. NULL until
  -- the first poll has established a baseline state.
  last_balance_state TEXT CHECK (last_balance_state IN ('above', 'below')),
  -- tx_activity only: the most recent transaction hash seen for this wallet as of the last poll —
  -- seeded to whatever's newest at creation time (see walletAlertScheduler.js), so a brand-new
  -- alert starts watching from "now" rather than notifying on the wallet's entire past history.
  last_seen_tx_hash TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wallet_alerts_owner_idx ON wallet_alerts (owner_wallet);
-- Scheduler's own access pattern: "every active alert, grouped by wallet_address" — see
-- walletAlertScheduler.js.
CREATE INDEX IF NOT EXISTS wallet_alerts_active_wallet_idx ON wallet_alerts (wallet_address) WHERE active;

-- Direction/USD-vs-ETN move alerts on any ERC-20 token — doesn't require the token to be in any
-- tracked wallet at all (see the build brief). baseline_price is deliberately per-row, not derived
-- from any shared price cache: it's "the price when THIS alert last armed", reset to the current
-- price on every trigger (recurring, not one-shot — see tokenPriceAlertScheduler.js's own header
-- comment) so the next notification always needs a fresh move from wherever the last one fired.
CREATE TABLE IF NOT EXISTS token_price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  token_address TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  threshold_pct NUMERIC NOT NULL CHECK (threshold_pct > 0),
  denomination TEXT NOT NULL CHECK (denomination IN ('USD', 'ETN')),
  baseline_price NUMERIC NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS token_price_alerts_owner_idx ON token_price_alerts (owner_wallet);
-- Scheduler's own access pattern: "every active alert, grouped by token_address" — one live price
-- quote per distinct token per poll, checked against every user's alert on that token, rather than
-- one quote per alert (see tokenPriceAlertScheduler.js).
CREATE INDEX IF NOT EXISTS token_price_alerts_active_token_idx ON token_price_alerts (token_address) WHERE active;
