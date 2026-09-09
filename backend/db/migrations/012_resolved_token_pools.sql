-- Which pool is a token's best WETN-paired pool, and separately its best pool of ANY type -- see
-- backend/utils/wetnPoolResolver.js. Both dexPriceQuote.js (live spot pricing) and pnlPricing.js
-- (historical pricing) used to run this same GeckoTerminal pools-list crawl + liquidity-ranking
-- independently, each in its own in-memory-only cache -- meaning every redeploy (this app has no
-- idle-spindown, but a deploy still restarts the process and wipes in-memory state) forced BOTH
-- files to re-pay the same GeckoTerminal API call, per token, all over again. Persisting the result
-- here means a redeploy costs nothing for this specific lookup going forward.
--
-- wetn_pool_* is NULL (both columns) when the token has no WETN-paired pool at all -- a real
-- negative, not "not yet resolved" (resolved_at is always set once a row exists either way).
-- best_pool_* mirrors wetn_pool_* when a WETN pool exists, otherwise the highest-liquidity pool of
-- any type, or NULL (both columns) if the token has no pools whatsoever.
--
-- *_is_base is GeckoTerminal's own base/quote designation for that pool, NOT an on-chain
-- token0/token1 ordering -- a caller needing the latter (dexPriceQuote.js, for its own on-chain
-- reserve/slot0 math) resolves it itself on top of whichever pool_address this table gives back;
-- that's one cheap on-chain call per pool, not worth persisting the way the GeckoTerminal crawl is.
CREATE TABLE IF NOT EXISTS resolved_token_pools (
  token_address TEXT PRIMARY KEY, -- lowercased
  wetn_pool_address TEXT,
  wetn_pool_is_base BOOLEAN,
  best_pool_address TEXT,
  best_pool_is_base BOOLEAN,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
