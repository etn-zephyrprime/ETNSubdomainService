import { getPools, getLiquidityLocks, isElectroSwapConfigured, electroSwapPausedForMs } from "./electroSwapApi.js";
import { normalizeLocks } from "./tokenLiquidityLockRouter.js";
import { getTokenLocksCache, setTokenLocksCache } from "../state/tokenLocksState.js";

// Keeps a public JSON cache of liquidity-lock summaries (count + latest unlock date) per token —
// backs a lock badge on EVERY row of the free Tokens tab (TokenLeaderboard.jsx), not just the lazy
// per-token lookup TokenDetail.jsx's own tokenLiquidityLockRouter.js does for whichever one token
// a visitor has opened.
//
// This is the one place in the app that calls ElectroSwap's own /liquidity-locks endpoint in bulk
// rather than lazily — deliberate, and safe specifically BECAUSE of how infrequently this runs and
// how tightly the calls are paced: that endpoint is flagged `heavy: true` in ElectroSwap's own
// OpenAPI spec (global concurrency limits, expect occasional 503 "server_busy" under load) and
// costs a flat 2000 credits per call with no batching. A full sweep of ~100-200 tokens (the same
// universe getPools already bounds liquidity to), one call at a time, once a WEEK (not hourly like
// tokenLiquidityCache.js — lock terms essentially never change on any shorter timescale; this was
// daily until a full sweep was measured at ~189k credits, ~$0.19), is a small, predictable cost
// rather than something that could ever be triggered by visitor traffic.
//
// A backend RESTART must not re-pay for that: the startup run only sweeps when the published cache is
// older than the interval, or is missing tokens — and then only the missing ones when the cache is
// otherwise fresh (see decideLockSweep). Without this, every deploy (and every spin-up on a host that
// sleeps the service) would trigger a full paid sweep.
//
// Merges into the PREVIOUS cache rather than replacing it wholesale — a token that fails or gets
// rate-limited this cycle keeps whatever was last known about it (still useful, since lock terms
// don't change) instead of the whole cache regressing to missing entries for a transient hiccup.
const CACHE_INTERVAL_MS = process.env.TOKEN_LOCKS_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_LOCKS_CACHE_INTERVAL_MS, 10)
  : 7 * 24 * 60 * 60 * 1000; // 7 days (604,800,000 ms — inside setInterval's 2^31 ms limit)

// Calls are made ONE AT A TIME with a gap between them (was: 2 concurrent, no gap). ElectroSwap's
// /liquidity-locks is a "heavy" route that rate-limits quickly, and the shared circuit breaker
// (electroSwapApi.js) then pauses EVERY call for a minute — see sweepTokenLocks below for why that
// mattered so much here. ~94 tokens at this spacing is a few minutes, once a day.
const LOCK_CALL_SPACING_MS = process.env.TOKEN_LOCKS_SPACING_MS ? parseInt(process.env.TOKEN_LOCKS_SPACING_MS, 10) : 1500;
const MAX_PASSES = 4; // how many times a sweep re-tries the tokens that didn't come back
// If the breaker says it will be closed for longer than this, stop and try again later rather than
// sitting on it.
const MAX_BREAKER_WAIT_MS = 5 * 60 * 1000;
// A sweep that couldn't finish schedules a follow-up soon instead of leaving the gap for a whole day.
const FOLLOWUP_MS = process.env.TOKEN_LOCKS_FOLLOWUP_MS ? parseInt(process.env.TOKEN_LOCKS_FOLLOWUP_MS, 10) : 15 * 60 * 1000;
const MAX_FOLLOWUPS = 6;
const PUBLISH_EVERY = 15; // publish progress this often, so a crash mid-sweep doesn't lose it

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks every address's locks, sequentially, and RETRIES the ones that don't come back.
 *
 * Why this is not just a loop: ElectroSwap's shared circuit breaker (electroSwapApi.js) answers "too
 * many requests" by pausing ALL calls for a minute — during which getLiquidityLocks returns null
 * instantly. The previous sweep counted every one of those as a failure and moved on, so once the
 * breaker tripped a dozen tokens in, the other ~80 were "failed" in a few milliseconds and not tried
 * again for 24 hours — confirmed live: 12 of 94 tokens had a lock entry, 82 had never been checked.
 * Here a call made while the breaker is open WAITS for it to close instead, and anything still
 * missing after a pass gets another pass. Never-checked tokens go first.
 *
 * Dependencies are injected so this can be tested without ElectroSwap. Mutates `locksByAddress`
 * (the merged cache). Returns { checked, failed: [addresses still unchecked] }.
 */
export async function sweepTokenLocks({
  addresses,
  locksByAddress,
  fetchLocks,
  breakerWaitMs = () => 0,
  sleep = sleepMs,
  spacingMs = LOCK_CALL_SPACING_MS,
  maxPasses = MAX_PASSES,
  maxBreakerWaitMs = MAX_BREAKER_WAIT_MS,
  onProgress = null,
}) {
  // Never-checked tokens first, so a partial sweep spends its calls where the gaps are.
  let pending = [...addresses].sort((a, b) => (locksByAddress[a] ? 1 : 0) - (locksByAddress[b] ? 1 : 0));
  let checked = 0;

  for (let pass = 1; pass <= maxPasses && pending.length > 0; pass++) {
    const retry = [];
    for (let i = 0; i < pending.length; i++) {
      const address = pending[i];

      const wait = breakerWaitMs();
      if (wait > maxBreakerWaitMs) {
        // The pause is too long to sit through — leave everything not yet done for the follow-up.
        return { checked, failed: [...retry, ...pending.slice(i)] };
      }
      if (wait > 0) await sleep(wait + 250);

      const rawLocks = await fetchLocks(address);
      if (rawLocks == null) {
        retry.push(address);
      } else {
        locksByAddress[address] = normalizeLocks(rawLocks);
        checked++;
        if (onProgress && checked % PUBLISH_EVERY === 0) await onProgress(checked);
      }
      await sleep(spacingMs);
    }
    pending = retry;
  }
  return { checked, failed: pending };
}

let isRunning = false;
let followups = 0;

/**
 * Which tokens a run should actually pay to check. Every /liquidity-locks call is 2,000 credits, so
 * this is where redundant spend is avoided. `mode`:
 *  - "scheduled": the weekly refresh — every token.
 *  - "followup":  a retry after an incomplete sweep — only tokens still missing from the cache.
 *  - "startup":   the run at backend start. If the published cache is fresh (younger than the
 *                 interval) it checks only what's missing — nothing at all if it's complete, so a
 *                 redeploy costs no lock calls; if it's stale or absent, everything.
 * Returns { toCheck, reason }. Pure, so it can be tested.
 */
export function decideLockSweep({ mode, previous, tokenAddresses, now = Date.now(), intervalMs = CACHE_INTERVAL_MS }) {
  const known = previous?.locksByAddress || {};
  const missing = tokenAddresses.filter((a) => !known[a]);

  if (mode === "followup") return { toCheck: missing, reason: "retrying tokens still missing" };
  if (mode === "scheduled") return { toCheck: tokenAddresses, reason: "scheduled full refresh" };

  const updatedMs = Date.parse(previous?.updatedAt || "");
  const fresh = Number.isFinite(updatedMs) && now - updatedMs < intervalMs;
  if (!fresh) return { toCheck: tokenAddresses, reason: previous ? "cache is older than the refresh interval" : "no cache yet" };
  return { toCheck: missing, reason: missing.length > 0 ? "cache is fresh but missing tokens" : "cache is fresh and complete" };
}

async function refreshAndPublish(mode = "scheduled") {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  let scheduleFollowup = false;
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
      scheduleFollowup = true; // most likely ElectroSwap being paused/limited right now — worth trying again soon
      return;
    }

    const previous = await getTokenLocksCache();
    const locksByAddress = { ...(previous?.locksByAddress || {}) };

    const { toCheck, reason } = decideLockSweep({ mode, previous, tokenAddresses: [...tokenAddresses] });
    if (toCheck.length === 0) {
      followups = 0; // everything known already — nothing left to do
      console.log(`🔒 Token locks cache: nothing to check (${reason}) — no lock calls made`);
      return;
    }
    console.log(`🔒 Token locks cache: checking ${toCheck.length}/${tokenAddresses.size} token(s) (${reason})`);

    const { checked, failed } = await sweepTokenLocks({
      addresses: toCheck,
      locksByAddress,
      fetchLocks: getLiquidityLocks,
      breakerWaitMs: electroSwapPausedForMs,
      onProgress: () => setTokenLocksCache(locksByAddress),
    });

    if (checked === 0) {
      console.warn(`⚠️  Token locks cache: 0/${tokenAddresses.size} token(s) checked successfully this cycle (${failed.length} failed) — keeping previous cache`);
      scheduleFollowup = true;
      return;
    }

    await setTokenLocksCache(locksByAddress);
    console.log(`🔒 Token locks cache updated — ${checked}/${tokenAddresses.size} token(s) checked this cycle${failed.length > 0 ? ` (${failed.length} still unchecked)` : ""}, ${Object.keys(locksByAddress).length} total known`);
    scheduleFollowup = failed.length > 0;
    if (!scheduleFollowup) followups = 0;
  } catch (err) {
    console.error("⚠️  Token locks cache refresh failed:", err.message);
    scheduleFollowup = true;
  } finally {
    isRunning = false;
    // Don't leave a gap for a whole day: a sweep that couldn't finish tries again shortly (bounded).
    if (scheduleFollowup && followups < MAX_FOLLOWUPS) {
      followups++;
      console.log(`🔒 Token locks cache: incomplete — trying again in ${Math.round(FOLLOWUP_MS / 60000)} min (${followups}/${MAX_FOLLOWUPS})`);
      setTimeout(() => refreshAndPublish("followup"), FOLLOWUP_MS).unref?.();
    }
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

  console.log(`🔒 Token locks cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, one call per ${LOCK_CALL_SPACING_MS}ms)`);
  refreshAndPublish("startup");
  setInterval(() => refreshAndPublish("scheduled"), CACHE_INTERVAL_MS);
}
