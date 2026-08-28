import { getValidatorRewardsCache, setValidatorRewardsCache } from "../state/validatorRewardsState.js";

// Keeps a public JSON cache of real per-UTC-day, per-validator block counts and ETN rewards
// earned, for the last ~90 days — powers Overview.jsx's "Validators" tile (total distinct
// validators seen) and its line chart (blocks produced per day, one line per validator, with
// reward totals alongside). Neither figure exists anywhere else: dailyBlockStatsCache.js already
// tracks per-day validator block counts, but has no reward data (raw `eth_getBlockByNumber`
// doesn't carry it, and this chain's RPC doesn't support `eth_getBlockReceipts` — confirmed
// live — so computing it from receipts would mean one extra RPC call *per transaction*, on top
// of the already-heaviest scan in this codebase).
//
// Deliberately a completely different data source and scan strategy from dailyBlockStatsCache.js
// / hourlyActivityCache.js: instead of walking blocks one at a time via RPC, this walks
// Blockscout's own `/api/v2/blocks?type=block` list, which already computes each block's reward
// server-side (`rewards: [{ type: "validator", reward: "<wei>" }]`, confirmed live — on this
// chain it's exactly the block's priority-fee revenue, base fee is burnt separately) and returns
// 50 blocks per page via keyset pagination (`next_page_params`, confirmed live it holds up at
// least a week back — no reason a plain DB-backed cursor would degrade further out). That's
// ~31,000 page requests for a full 90-day backfill instead of ~1.5M individual RPC calls — a
// different, much smaller budget, and one that doesn't compete with the RPC endpoint at all
// (see dailyBlockStatsCache.js's own header comment for what happened when two scanners shared
// one over-eager budget). Sequential by nature (each page's cursor depends on the last), with a
// small delay between requests — no concurrency knob needed here, unlike the RPC-based scanners.
//
// Same dual-cursor shape as dailyBlockStatsCache.js otherwise: `highScannedBlock` stays caught up
// to chain tip every cycle so today's numbers are never stale, while backfill (tracked via
// `lowCursorParams`, Blockscout's own opaque next-page cursor rather than a block number — its
// keyset cursor isn't reconstructable from a height alone, see fetchBlocksPage's caller) works
// backward in the background, bounded per cycle. `lowCursorParams` is `null` once backfill has
// reached the 90-day cutoff.
const BLOCKSCOUT_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const DAYS_TO_KEEP = 90;
const CACHE_SCHEMA_VERSION = 1;
const CACHE_INTERVAL_MS = process.env.VALIDATOR_REWARDS_CACHE_INTERVAL_MS
  ? parseInt(process.env.VALIDATOR_REWARDS_CACHE_INTERVAL_MS, 10)
  : 300000;
// 50 blocks/page, so 200 pages/cycle ≈ 10,000 blocks — a full 90-day backfill (~31,000 pages)
// takes roughly a day at the default 5-minute cadence. Conservative on purpose: Blockscout's own
// rate limits for this volume of sequential requests aren't documented, and this repo already
// learned the hard way (see dailyBlockStatsCache.js) what guessing too high costs.
const MAX_PAGES_PER_CYCLE = process.env.VALIDATOR_REWARDS_MAX_PAGES_PER_CYCLE
  ? parseInt(process.env.VALIDATOR_REWARDS_MAX_PAGES_PER_CYCLE, 10)
  : 200;
const PAGE_DELAY_MS = process.env.VALIDATOR_REWARDS_PAGE_DELAY_MS
  ? parseInt(process.env.VALIDATOR_REWARDS_PAGE_DELAY_MS, 10)
  : 150;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBlocksPage(cursorParams, attempt = 0) {
  const url = new URL(`${BLOCKSCOUT_API_BASE}/blocks`);
  url.searchParams.set("type", "block");
  if (cursorParams) {
    for (const [key, value] of Object.entries(cursorParams)) url.searchParams.set(key, value);
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json(); // { items: [...], next_page_params: {...} | null }
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchBlocksPage(cursorParams, attempt + 1);
    }
    throw err;
  }
}

// Applies one page's blocks (newest-first within the page) to `days`, stopping the moment a
// block's UTC day falls before `cutoffDate` — safe to stop rather than skip-and-continue since
// the page (and every page after it) is strictly time-descending, so nothing older ever needs
// re-checking once the cutoff is crossed.
function applyPageBlocks(days, items, cutoffDate) {
  for (const block of items) {
    const dayKey = String(block.timestamp).slice(0, 10);
    if (dayKey < cutoffDate) return { crossedCutoff: true };

    const miner = String(block.miner?.hash || "").toLowerCase();
    const validatorReward = (block.rewards || []).find((r) => r.type === "validator");
    const rewardWei = validatorReward ? BigInt(validatorReward.reward) : 0n;

    const day = days[dayKey] || (days[dayKey] = { validators: {} });
    const v = day.validators[miner] || (day.validators[miner] = { blocks: 0, rewardWei: "0" });
    v.blocks += 1;
    v.rewardWei = (BigInt(v.rewardWei) + rewardWei).toString();
  }
  return { crossedCutoff: false };
}

let isRunning = false;

async function scanAndPublish() {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getValidatorRewardsCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const days = cached?.days ? { ...cached.days } : {};
    let highScannedBlock = cached?.highScannedBlock ?? null;
    let lowCursorParams = cached?.lowCursorParams; // undefined: not yet started; object: mid-backfill; null: complete

    const cutoffDate = new Date(Date.now() - DAYS_TO_KEEP * 86400000).toISOString().slice(0, 10);

    if (highScannedBlock == null) {
      // First run ever — one bounded walk back from the chain tip covers both "today's numbers
      // exist immediately" and seeds lowCursorParams for future backfill cycles, same
      // "recency over completeness" reasoning as dailyBlockStatsCache.js.
      let cursor;
      let crossed = false;
      for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
        const result = await fetchBlocksPage(cursor);
        if (!result.items?.length) { crossed = true; break; }
        if (highScannedBlock == null) highScannedBlock = result.items[0].height;
        const { crossedCutoff } = applyPageBlocks(days, result.items, cutoffDate);
        if (crossedCutoff || !result.next_page_params) { crossed = true; break; }
        cursor = result.next_page_params;
        await sleep(PAGE_DELAY_MS);
      }
      lowCursorParams = crossed ? null : cursor;
    } else {
      // Tip catch-up — walk back from the chain tip until reaching already-scanned territory
      // (a partial page's worth most cycles, at ~5s blocks and a 300s default interval).
      let cursor;
      let newHighScannedBlock = highScannedBlock;
      for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
        const result = await fetchBlocksPage(cursor);
        if (!result.items?.length) break;
        const newItems = result.items.filter((b) => b.height > highScannedBlock);
        if (newItems.length === 0) break; // fully caught up
        if (page === 0) newHighScannedBlock = newItems[0].height;
        applyPageBlocks(days, newItems, cutoffDate);
        if (newItems.length < result.items.length || !result.next_page_params) break; // rest of this page was already-scanned
        cursor = result.next_page_params;
        await sleep(PAGE_DELAY_MS);
      }
      highScannedBlock = newHighScannedBlock;

      // Backfill — continue from where the last cycle left off, bounded per cycle.
      if (lowCursorParams !== null) {
        let cursor = lowCursorParams;
        let crossed = false;
        for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
          const result = await fetchBlocksPage(cursor);
          if (!result.items?.length) { crossed = true; break; }
          const { crossedCutoff } = applyPageBlocks(days, result.items, cutoffDate);
          if (crossedCutoff || !result.next_page_params) { crossed = true; break; }
          cursor = result.next_page_params;
          await sleep(PAGE_DELAY_MS);
        }
        lowCursorParams = crossed ? null : cursor;
      }
    }

    // Self-pruning — same "oldest drops off first" convention as dailyBlockStatsCache.js.
    for (const day of Object.keys(days)) {
      if (day < cutoffDate) delete days[day];
    }

    await setValidatorRewardsCache({ days, highScannedBlock, lowCursorParams, schemaVersion: CACHE_SCHEMA_VERSION });

    const backfillDone = lowCursorParams === null;
    console.log(`🛡️  Validator rewards cache updated — ${Object.keys(days).length} day(s) tracked, backfill ${backfillDone ? "complete" : "in progress"}, caught up to block ${highScannedBlock}`);
  } catch (err) {
    console.error("⚠️  Validator rewards scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startValidatorRewardsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — validator rewards cache disabled");
    return;
  }

  console.log(`🛡️  Validator rewards cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish();
  setInterval(scanAndPublish, CACHE_INTERVAL_MS);
}
