// backend/scripts/backfillTokenBurns.js
//
// Drives tokenBurnService.js's per-token burn scan all the way back to each token's own deploy
// block, for every token that has a real, active ElectroSwap liquidity pool (V2 or V3) — rather
// than waiting on organic Tokens-tab page views to each contribute one MAX_BLOCKS_PER_CALL-sized
// step. The interactive path (a visitor opening a token's page) only ever advances a token's
// history by one bounded step per view, and the backward half specifically only progresses for
// tokens people actually click into — a rarely-viewed token's chart can sit stuck at "history since
// whenever it was first viewed" indefinitely. This script instead: 1) asks ElectroSwap which
// tokens are actually pooled (same getPools(2,...)/getPools(3,...) call tokenLiquidityCache.js
// already makes for the free Tokens tab's liquidity figures — the token addresses on either side of
// a returned pool ARE "a token with an active liquidity pool"), then 2) for each one, calls
// backfillTokenFully (tokenBurnService.js) to step it all the way back to its own deploy block.
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

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do (token_burn_cursor/token_burn_events live in Postgres).");
  }

  console.log("Fetching ElectroSwap's pool list (V2 + V3) to find every token with an active liquidity pool...");
  const tokenAddresses = await collectPooledTokenAddresses();
  console.log(`Found ${tokenAddresses.length} distinct pooled token(s). Backfilling each to its own deploy block...\n`);

  const summary = [];
  for (const [i, address] of tokenAddresses.entries()) {
    process.stdout.write(`[${i + 1}/${tokenAddresses.length}] ${address} — `);
    let steps = 0;
    let newEvents = 0;
    try {
      const result = await backfillTokenFully(address, {
        maxSteps: MAX_STEPS_PER_TOKEN,
        onStep: (step) => {
          steps += 1;
          newEvents += step.newEventsCount;
        },
      });
      const status = result.fullyBackfilled ? "done" : result.hitMaxSteps ? `hit ${MAX_STEPS_PER_TOKEN}-step cap, re-run to continue` : "incomplete";
      console.log(`${status} — ${steps} step(s), ${newEvents} new burn event(s) found`);
      summary.push({ address, status, steps, newEvents });
    } catch (err) {
      console.log(`FAILED after ${steps} step(s): ${err.message}`);
      summary.push({ address, status: "failed", steps, newEvents, error: err.message });
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
