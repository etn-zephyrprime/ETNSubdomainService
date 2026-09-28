// backend/scripts/backfillTokenBurns.js
//
// Drives tokenBurnService.js's per-token burn scan all the way back to each token's own deploy
// block, for tokens worth having full burn history for — a real liquidity lock OR a burned
// liquidity pool (per tokenLocksCache.js's own published summary), NOT every pooled token
// indiscriminately (an earlier version of this script did that; most of ElectroSwap's ~100-200
// pooled tokens are low-effort/low-interest listings nobody's asked about, and backfilling every
// one of them wastes RPC calls and Postgres rows on tokens nobody cares about). This still starts
// from the pooled-token universe (same getPools(2,...)/getPools(3,...) call tokenLiquidityCache.js
// makes) since a token needs SOME pool to have a lock on in the first place, then narrows it down
// using token-locks.json (the same weekly ElectroSwap /liquidity-locks sweep that already powers
// the Tokens tab's lock badge — see tokenLocksCache.js/lockStatus.js) — count > 0 there covers both
// a real time-locked LP position and a burned/permanent one (normalizeLocks folds burned locks into
// the same `count`, just also into `permanentCount`).
//
// Without this filter the interactive path (a visitor opening a token's page) only ever advances a
// token's history by one bounded step per view, and the backward half specifically only progresses
// for tokens people actually click into — a rarely-viewed token's chart can sit stuck at "history
// since whenever it was first viewed" indefinitely. This script pushes it all the way back in one
// go for the tokens that are actually worth it.
//
// Usage:
//   node backend/scripts/backfillTokenBurns.js
//
// Safe to re-run: a token whose history is already fully backfilled just reports 0 steps and moves
// on immediately (backfillTokenFully's very first step returns fullyBackfilled: true). Safe to
// interrupt (Ctrl+C) and resume later — the underlying cursor is persisted per-step in Postgres,
// same as the interactive path, so nothing already scanned is redone.
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { getPools } from "../utils/electroSwapApi.js";
import { getTokenLocksCache } from "../state/tokenLocksState.js";
import { backfillTokenFully } from "../services/tokenBurnService.js";

dotenv.config();

// Same per-token step size the interactive path uses by default (see tokenBurnService.js's own
// MAX_BLOCKS_PER_CALL) — this script just takes many steps back-to-back instead of one per page
// view. Override via TOKEN_BURN_MAX_BLOCKS_PER_CALL if a faster/slower pace is wanted for this run
// specifically (larger = fewer, heavier RPC calls; smaller = gentler on the RPC endpoint).
const MAX_STEPS_PER_TOKEN = process.env.TOKEN_BURN_BACKFILL_MAX_STEPS
  ? parseInt(process.env.TOKEN_BURN_BACKFILL_MAX_STEPS, 10)
  : 2000; // generous — real usage as of writing needs nowhere near this many steps per token

async function collectPooledTokenAddresses() {
  const [poolsV2, poolsV3] = await Promise.all([getPools(2, 100), getPools(3, 100)]);
  const pools = [...(poolsV2 || []), ...(poolsV3 || [])];
  if (pools.length === 0) {
    throw new Error("ElectroSwap returned no pools at all (both V2 and V3) — check ELECTROSWAP_API_KEY before assuming there's really nothing pooled.");
  }

  const addresses = new Set();
  for (const pool of pools) {
    if (pool?.token0?.address) addresses.add(pool.token0.address.toLowerCase());
    if (pool?.token1?.address) addresses.add(pool.token1.address.toLowerCase());
  }
  return [...addresses];
}

/** Narrows `pooledAddresses` down to the ones token-locks.json says have at least one lock (real
 * or burned — see this file's own header comment). Throws rather than silently falling back to
 * "everything pooled" if the cache isn't there yet — that's exactly the unwanted behavior this
 * filter exists to replace, so a missing/unconfigured cache should stop the run, not quietly do the
 * old thing. */
async function filterToLockedOrBurned(pooledAddresses) {
  const cache = await getTokenLocksCache();
  if (!cache?.locksByAddress) {
    throw new Error(
      "token-locks.json hasn't been published yet (or R2 isn't configured) — tokenLocksCache.js's weekly sweep needs to have run at least once before this script can tell which tokens have a lock. Check R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, and that the backend has been up long enough for its startup lock sweep to finish."
    );
  }
  return pooledAddresses.filter((addr) => (cache.locksByAddress[addr]?.count || 0) > 0);
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do (token_burn_cursor/token_burn_events live in Postgres).");
  }

  console.log("Fetching ElectroSwap's pool list (V2 + V3) to find every token with an active liquidity pool...");
  const pooledAddresses = await collectPooledTokenAddresses();
  console.log(`Found ${pooledAddresses.length} distinct pooled token(s). Checking token-locks.json for which ones have a lock or burned LP...`);
  const tokenAddresses = await filterToLockedOrBurned(pooledAddresses);
  console.log(`${tokenAddresses.length} of ${pooledAddresses.length} pooled token(s) have a liquidity lock or burned LP. Backfilling those to their own deploy block...\n`);

  // A single step can cover a 20,000-block range and run for minutes — this prints one throttled
  // line so a long run doesn't look hung, without the earlier per-chunk/per-phase/per-step noise.
  const PROGRESS_INTERVAL_MS = 15000;
  const TOKEN_FAILURE_COOLDOWN_MS = process.env.TOKEN_BURN_BACKFILL_FAILURE_COOLDOWN_MS
    ? parseInt(process.env.TOKEN_BURN_BACKFILL_FAILURE_COOLDOWN_MS, 10)
    : 30000;

  const summary = [];
  for (const [i, address] of tokenAddresses.entries()) {
    let steps = 0;
    let newEvents = 0;
    let lastPrint = 0;
    const onProgress = (p) => {
      if (p.phase !== "logs") return; // logs phase alone is enough to show it's alive
      const now = Date.now();
      if (now - lastPrint < PROGRESS_INTERVAL_MS) return;
      lastPrint = now;
      const span = p.rangeEnd - p.rangeStart || 1;
      const pct = (((p.scannedTo - p.rangeStart) / span) * 100).toFixed(0);
      console.log(`  [${i + 1}/${tokenAddresses.length}] ${address} — step ${steps + 1}, ${pct}% of range, ${newEvents + p.foundSoFar} burn(s) so far`);
    };
    try {
      const result = await backfillTokenFully(address, {
        maxSteps: MAX_STEPS_PER_TOKEN,
        onProgress,
        onStep: (step) => {
          steps += 1;
          newEvents += step.newEventsCount;
        },
        // A step already retries itself a few times (see backfillTokenFully) before this fires the
        // LAST time — just a one-line heads-up so a slow patch of retries doesn't look identical to
        // the "quiet for 15s, must still be working" case above.
        onRetry: (r) => console.log(`  [${i + 1}/${tokenAddresses.length}] ${address} — retry ${r.attempt}/${r.maxAttempts} in ${r.delayMs / 1000}s (${r.error.message})`),
      });
      const status = result.fullyBackfilled ? "done" : result.hitMaxSteps ? `hit ${MAX_STEPS_PER_TOKEN}-step cap, re-run to continue` : "incomplete";
      console.log(`[${i + 1}/${tokenAddresses.length}] ${address}: ${status} — ${steps} step(s), ${newEvents} new burn(s)`);
      summary.push({ address, status, steps, newEvents });
    } catch (err) {
      console.log(`[${i + 1}/${tokenAddresses.length}] ${address}: FAILED after ${steps} step(s) — ${err.message}`);
      summary.push({ address, status: "failed", steps, newEvents, error: err.message });
      // A failure here means retries already ran out inside backfillTokenFully — i.e. this wasn't
      // a one-off blip, both RPC endpoints were genuinely struggling. Rushing straight into the
      // next token's first call just repeats the same failure (confirmed live: 9 tokens in a row
      // failed instantly after one busy token tripped this). A longer pause here gives the RPC
      // endpoints real time to recover before asking them for anything else.
      console.log(`  pausing ${TOKEN_FAILURE_COOLDOWN_MS / 1000}s before the next token...`);
      await new Promise((resolve) => setTimeout(resolve, TOKEN_FAILURE_COOLDOWN_MS));
    }
  }

  const failed = summary.filter((s) => s.status === "failed");
  const totalNewEvents = summary.reduce((sum, s) => sum + s.newEvents, 0);
  console.log(`\nDone — ${summary.length} token(s) processed, ${totalNewEvents} new burn event(s) found total.`);
  if (failed.length > 0) {
    console.log(`${failed.length} token(s) failed and were skipped — re-run this script to retry just those (already-completed tokens are instant no-ops):`);
    failed.forEach((s) => console.log(`  ${s.address}: ${s.error}`));
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
