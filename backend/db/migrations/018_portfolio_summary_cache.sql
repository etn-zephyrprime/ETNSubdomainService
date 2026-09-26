-- Last-known Core Tier portfolio summary per member, so the Portfolio tab can show real numbers the
-- instant it opens instead of building the total from scratch on every load (native ETN + token
-- balances come live from Blockscout in the browser, and liquidity/staking values take a while — the
-- headline total used to be a partial figure that jumped when those arrived).
--
-- Keyed by the MEMBER's connected wallet (owner_wallet), not per tracked wallet: the summary covers
-- that member's whole covered-wallet set, and two members tracking the same address can hold
-- different sets. `payload` is a small, server-sanitized breakdown per covered wallet (native /
-- tokens / liquidity / staking USD) — the frontend derives totals and the category filter from it.
-- One row per member, overwritten on each save; no history.
CREATE TABLE IF NOT EXISTS portfolio_summary_cache (
  owner_wallet TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
