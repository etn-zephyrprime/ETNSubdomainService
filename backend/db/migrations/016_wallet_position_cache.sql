-- Persisted "last known" live value of a wallet's open DeFi (farm/staking) positions and directly-
-- held liquidity positions — see backend/services/defiPositionValuation.js and lpPositionValuation.js.
--
-- Distinct from wallet_ingestion_state/defi_activity: those track DISCOVERY (which farms/stakes a
-- wallet has ever touched, and how far its history has been ingested) — this table caches the
-- CURRENT USD VALUE of what's open right now, which was never persisted anywhere before this and had
-- to be recomputed from scratch (several live RPC reads + live GeckoTerminal pricing) on every
-- single Core Tier page load, taking on the order of a minute even for a wallet whose on-chain
-- position hadn't changed at all since the last load seconds earlier — confirmed live, this is
-- exactly why "the data is in Supabase" didn't actually make Liquidity Positions/Staking fast: the
-- discovery data was, the current-value figure never was.
--
-- One row per (tracked_wallet, kind) — overwritten on every fresh computation, no history kept
-- (nothing here needs looking back on once superseded). `payload` is the exact JSON shape the
-- frontend already consumes (see getOpenDefiPositionsUsd/getLiquidityPositionsUsd's own return
-- shape) so a cache hit can be served completely unchanged, no reshaping needed. `fingerprint` is
-- the freshness signal that decides whether a served row is still CORRECT (not just "last known"):
--   - kind='defi': wallet_ingestion_state.updated_at (as epoch ms, stringified) at the moment this
--     was computed — a farm/stake position's own on-chain amount only ever changes via a deposit/
--     withdraw tx, which is ingested (bumping updated_at) before this table's own value could
--     possibly be wrong about it, so an unchanged updated_at means the payload's QUANTITIES are
--     still exactly right (live price movement is the only thing that can have drifted, same bounded
--     staleness this app already accepts for a quiet wallet's live pricing elsewhere).
--   - kind='lp': a fingerprint of the wallet's held-fungible-token list (address:balance pairs) at
--     computation time — no ingested ledger drives LP discovery (candidates come from the wallet's
--     own live balances), so a real balance change is the freshness signal instead.
CREATE TABLE IF NOT EXISTS wallet_position_cache (
  tracked_wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('defi', 'lp')),
  payload JSONB NOT NULL,
  fingerprint TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tracked_wallet, kind)
);
