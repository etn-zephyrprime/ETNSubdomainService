import { getPools, getLiquidityLocks, isElectroSwapConfigured } from "./electroSwapApi.js";
import { normalizeLocks } from "./tokenLiquidityLockRouter.js";
import { getTokenLocksCache, setTokenLocksCache } from "../state/tokenLocksState.js";

// Keeps a public JSON cache of liquidity-lock summaries (count + latest unlock date) per token —
// backs a lock badge on EVERY row of the free Tokens tab (TokenLeaderboard.jsx), not just the lazy
// per-token lookup TokenDetail.jsx's own tokenLiquidityLockRouter.js does for whichever one token
// a visitor has opened.
//
// This is the one place in the app that calls ElectroSwap's own /liquidity-locks endpoint in bulk
// rather than lazily — deliberate, and safe specifically BECAUSE of how infrequently this runs and
// how tightly concurrency is bounded: that endpoint is flagged `heavy: true` in ElectroSwap's own
// OpenAPI spec (global concurrency limits, expect occasional 503 "server_busy" under load) and
// costs a flat 2000 credits per call with no batching. A full sweep of ~100-200 tokens (the same
// universe getPools already bounds liquidity to) at LOW concurrency, once a DAY (not hourly like
// tokenLiquidityCache.js — confirmed acceptable per explicit direction that lock terms essentially
// never change on any shorter timescale), is a small, predictable, one-time-a-day cost rather than
// something that could ever be triggered by visitor traffic.
//
// Merges into the PREVIOUS cache rather than replacing it wholesale — a token that fails or gets
// rate-limited this cycle keeps whatever was last known about it (still useful, since lock terms
// don't change) instead of the whole cache regressing to missing entries for a transient hiccup.
const CACHE_INTERVAL_MS = process.env.TOKEN_LOCKS_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_LOCKS_CACHE_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000; // 24 hours

const LOCK_READ_CONCURRENCY = process.env.TOKEN_LOCKS_CONCURRENCY
  ? parseInt(process.env.TOKEN_LOCKS_CONCURRENCY, 10)
  : 2; // deliberately low — see this file's own header comment on why ("heavy" route, global concurrency limits)

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const [poolsV2, poolsV3] = await Promise.all([getPools(2, 100), getPools(3, 100)]);
    const pools = [...(poolsV2 || []), ...(poolsV3 || [])];

    const tokenAddresses = new Set();
    for (const pool of pools) {
      if (pool?.token0?.address) tokenAddresses.add(pool.token0.address.toLowerCase());
      if (pool?.token1?.address) tokenAddresses.add(pool.token1.address.toLowerCase());
    }

    if (tokenAddresses.size === 0) {
      console.warn("⚠️  Token locks cache: no pools returned this cycle — nothing to check, keeping previous cache");
      return;
    }

    const previous = await getTokenLocksCache();
    const locksByAddress = { ...(previous?.locksByAddress || {}) };
    let checked = 0;
    let failed = 0;

    await mapWithConcurrency([...tokenAddresses], LOCK_READ_CONCURRENCY, async (address) => {
      const rawLocks = await getLiquidityLocks(address);
      if (rawLocks == null) {
        failed++;
        return; // leave whatever was previously known (if anything) untouched
      }
      locksByAddress[address] = normalizeLocks(rawLocks);
      checked++;
    });

    if (checked === 0) {
      console.warn(`⚠️  Token locks cache: 0/${tokenAddresses.size} token(s) checked successfully this cycle (${failed} failed) — keeping previous cache`);
      return;
    }

    await setTokenLocksCache(locksByAddress);
    console.log(`🔒 Token locks cache updated — ${checked}/${tokenAddresses.size} token(s) checked this cycle${failed > 0 ? ` (${failed} failed)` : ""}, ${Object.keys(locksByAddress).length} total known`);
  } catch (err) {
    console.error("⚠️  Token locks cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured (nowhere public to publish
 * to) or ElectroSwap isn't configured (no lock data source at all).
 */
export function startTokenLocksCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — token locks cache disabled");
    return;
  }
  if (!isElectroSwapConfigured()) {
    console.log("ℹ️  ELECTROSWAP_API_KEY not set — token locks cache disabled");
    return;
  }

  console.log(`🔒 Token locks cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, concurrency ${LOCK_READ_CONCURRENCY})`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
