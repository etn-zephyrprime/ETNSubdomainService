-- Per-token burn history, for TokenDetail.jsx's Tokens tab — a cumulative "how much of this token
-- has been burned over time" chart (see backend/services/tokenBurnService.js's own header comment
-- for exactly what counts as a burn and why it differs per token: most tokens have no real burn()
-- function at all, so sending to the conventional 0x000...dEaD address is the only way anyone
-- "burns" them, purely by convention (total supply is unaffected); CORE has a genuine burn()
-- function that reduces total supply, which always shows up as a Transfer to the true zero address
-- (0x0) — see coreClashBurnWatcher.js's own identical distinction for the existing Telegram burn
-- alerts, which watches the exact same zero-address Transfer events for CORE specifically).
--
-- Deliberately per-token, unlike nftSalesCache.js's one-shared-contract (Seaport) R2 cache — burns
-- happen on an arbitrary, unbounded number of different token contracts (whichever one a visitor
-- happens to view), so this uses Postgres (already this app's mechanism for per-key durable cursor
-- state, e.g. wallet_ingestion_state) rather than one shared JSON blob that would have to hold
-- every token ever looked at.

-- Resumable scan progress for ONE token — same dual-cursor "catch up to tip, backfill older
-- history in the background" shape as nftSalesCache.js, just persisted per-token here instead of in
-- one shared R2 object. `deploy_block` is the token contract's own creation block (resolved once,
-- via its creation transaction) — the real floor for backfilling, so this never wastes RPC calls
-- scanning empty ranges before the token even existed.
CREATE TABLE IF NOT EXISTS token_burn_cursor (
  token_address TEXT PRIMARY KEY,
  deploy_block BIGINT,
  low_scanned_block BIGINT,
  high_scanned_block BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per burn Transfer event actually found. `amount` is the raw integer string in the
-- token's own smallest unit (not decimal-shifted) — same "store raw, format at the display
-- boundary with whatever `decimals` the caller already has" convention as ingestedTransfers.js;
-- TokenDetail.jsx already has the token's own `decimals` loaded (it's part of Blockscout's own
-- token response), so there's no need for this table or its reader to know it at all.
CREATE TABLE IF NOT EXISTS token_burn_events (
  token_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token_address, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS token_burn_events_token_ts_idx ON token_burn_events (token_address, "timestamp");
