// backend/utils/wetnPoolResolver.js
//
// Shared "which pool is this token's best WETN-paired pool (and, separately, its best pool of ANY
// type)" resolution — the actual expensive, bandwidth-costing part of both dexPriceQuote.js's live
// spot pricing and pnlPricing.js's historical pricing, which each used to run this same
// GeckoTerminal pools-list crawl + liquidity-ranking independently, in their own in-memory-only
// cache. That meant every redeploy (this app runs on Render Starter — always-on, no idle spindown,
// but a deploy still restarts the process and wipes in-memory state) forced BOTH files to re-pay
// the same GeckoTerminal API call, per token, for every token either one had ever priced.
//
// Persisted to Supabase (resolved_token_pools, via db/resolvedPools.js) specifically because this
// crawl is the genuinely expensive part — a real external API response, not a cheap on-chain read
// — unlike the small single-eth_call metadata caches elsewhere in this app (token decimals, DeFi
// farm/contract metadata, etc.), which stay in-memory-only on purpose: persisting those would add
// real write-path complexity for savings too small to matter (see the "electroswap-api" memory /
// this session's own bandwidth discussion for the reasoning).
//
// Read-through with a short in-memory layer on top of the DB (avoids a Supabase round-trip on
// every single call within one process for a hot token) — NOT "resolve once, forever": a token's
// best pool CAN change over its life (a new, more liquid pool launching, a migration to a new pool
// type), so this re-validates against GeckoTerminal periodically, same STALE_AFTER_MS reasoning as
// pnlPricing.js's own original POOL_CACHE_TTL_MS, now applied consistently for both callers rather
// than just the one that happened to have it.
import { fetchGeckoTerminal } from "./tokenChartRouter.js";
import { getResolvedPool, upsertResolvedPool } from "../db/resolvedPools.js";

const NETWORK = "electroneum";
// Same wrapped-ETN address every other file in this app resolves pools against — ETN/WETN are 1:1
// pegged; GeckoTerminal indexes the wrapped pools, not native ETN transfers.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const STALE_AFTER_MS = 15 * 60 * 1000; // matches pnlPricing.js's original POOL_CACHE_TTL_MS

const memCache = new Map(); // tokenAddress (lowercased) -> { result, expiresAt } — per-process only; Supabase is the durable layer

function rowToResult(row) {
  return {
    wetnPool: row.wetn_pool_address ? { poolAddress: row.wetn_pool_address, tokenIsBase: row.wetn_pool_is_base } : null,
    bestPool: row.best_pool_address ? { poolAddress: row.best_pool_address, tokenIsBase: row.best_pool_is_base } : null,
  };
}

async function fetchAndRankPools(tokenAddress) {
  let pools = [];
  try {
    const res = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${tokenAddress}/pools`);
    pools = res.data || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (pools.length === 0) return { wetnPool: null, bestPool: null };

  const tokenId = `${NETWORK}_${tokenAddress}`;
  const wetnId = `${NETWORK}_${WETN_ADDRESS}`;
  const wetnPools = pools.filter((p) => {
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const otherId = baseId === tokenId ? quoteId : baseId;
    return otherId === wetnId;
  });

  const highestLiquidity = (list) =>
    list.reduce((a, b) => (Number(b.attributes.reserve_in_usd || 0) > Number(a.attributes.reserve_in_usd || 0) ? b : a));
  const toResult = (pool) => ({ poolAddress: pool.attributes.address, tokenIsBase: pool.relationships?.base_token?.data?.id === tokenId });

  const wetnPool = wetnPools.length > 0 ? toResult(highestLiquidity(wetnPools)) : null;
  const bestPool = wetnPool || toResult(highestLiquidity(pools));
  return { wetnPool, bestPool };
}

/**
 * `{ wetnPool, bestPool }`, each either `{ poolAddress, tokenIsBase }` or `null`.
 *
 * `wetnPool` — the highest-liquidity pool trading this token directly against WETN, or `null` if
 * none exists. Use this when you specifically need a WETN-denominated pool (e.g. dexPriceQuote.js's
 * on-chain reserve/slot0 math, which requires knowing the WETN leg to derive an ETN price at all).
 *
 * `bestPool` — `wetnPool` if it exists, otherwise the highest-liquidity pool of ANY type, or `null`
 * only if the token has no pools whatsoever. Use this when a non-WETN pool is still useful (e.g.
 * pnlPricing.js's historical lookups, which ask GeckoTerminal's OHLCV endpoint for a USD-converted
 * price server-side — GeckoTerminal handles the currency conversion regardless of which pool it is,
 * so a non-WETN pool still gives a real answer there, unlike dexPriceQuote's own on-chain math).
 *
 * `tokenIsBase` is GeckoTerminal's own base/quote designation for that pool — NOT an on-chain
 * token0/token1 ordering. A caller needing the latter resolves it itself (one cheap on-chain call)
 * on top of whichever poolAddress this returns.
 */
export async function resolveTokenPools(tokenAddress) {
  const key = tokenAddress.toLowerCase();

  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.result;

  // Never let a persistence-layer hiccup (a transient Supabase error, or this migration not having
  // run yet on a fresh deploy) take down pool resolution itself — same "degrade, don't break"
  // convention as the rest of this app's pricing code. Treated identically to "no row found": falls
  // straight through to a fresh GeckoTerminal fetch below, just without the durability win this
  // file exists for, until the DB read works again.
  let row = null;
  try {
    row = await getResolvedPool(key);
  } catch (err) {
    console.warn(`⚠️  Couldn't read resolved pool for ${key} from Supabase, falling back to a fresh lookup:`, err.message);
  }
  if (row && Date.now() - new Date(row.resolved_at).getTime() < STALE_AFTER_MS) {
    const result = rowToResult(row);
    memCache.set(key, { result, expiresAt: Date.now() + STALE_AFTER_MS });
    return result;
  }

  const result = await fetchAndRankPools(key);
  // Fire this after the caller already has its answer — a Supabase write failure shouldn't turn a
  // successful GeckoTerminal resolution into a failed call; it just means this one won't be
  // persisted and gets re-resolved next time, same degraded-but-correct behavior as DATABASE_URL
  // not being configured at all (see db/pool.js's own query() contract).
  upsertResolvedPool(key, {
    wetnPoolAddress: result.wetnPool?.poolAddress ?? null,
    wetnPoolIsBase: result.wetnPool?.tokenIsBase ?? null,
    bestPoolAddress: result.bestPool?.poolAddress ?? null,
    bestPoolIsBase: result.bestPool?.tokenIsBase ?? null,
  }).catch((err) => console.warn(`⚠️  Couldn't persist resolved pool for ${key}:`, err.message));

  memCache.set(key, { result, expiresAt: Date.now() + STALE_AFTER_MS });
  return result;
}
