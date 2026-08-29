import { getDailyBlockStatsCache, setDailyBlockStatsCache } from "../state/dailyBlockStatsState.js";

// Keeps a public JSON cache of real per-UTC-day transaction counts and validator (miner)
// block-production breakdowns for the last ~90 days — powers Overview.jsx's "Total Transactions"
// chart (a genuine 90-day view, not Blockscout's 31-day-capped one) and its "Total Blocks"
// heatmap (cell brightness = that day's tx count, tooltip = which validators produced blocks that
// day). Neither figure exists anywhere else: Blockscout's own `/stats/charts/transactions` only
// keeps 31 real days (confirmed live), and it has no validator/miner breakdown at all, for any
// day — this backend is the only place either could come from.
//
// Rewritten to scan Blockscout's own `/api/v2/blocks?type=block` list instead of raw RPC — same
// migration and same reasoning as validatorRewardsCache.js (see that file's header comment in
// full): this cache's original per-block RPC scan (`eth_getBlockByNumber` × ~1.5M blocks for a
// full 90-day backfill) was, on its own, most of the RPC volume this backend's Ankr account was
// burning — a real cost driver, not just a rate-limit annoyance, confirmed live via Ankr's own
// per-project request-volume dashboard after that key got disabled outright. Blockscout's block
// list already carries `transaction_count` and `miner.hash` per block (confirmed live), so this
// needs zero RPC calls now — ~31,000 page requests (50 blocks/page) for a full 90-day backfill
// against Blockscout, not ~1.5M against Ankr. `hourlyActivityCache.js` (real ETN volume
// transferred, which needs full transaction values Blockscout's block list doesn't carry) stays
// on RPC — this migration only covers what Blockscout's block-list summary can actually answer.
//
// Cursor state is NOT compatible with the old RPC-based version (Blockscout's keyset
// `next_page_params` isn't a block number), so CACHE_SCHEMA_VERSION bumped — the published `days`
// shape is unchanged (still `{ txCount, blockCount, validators }` per day, same as before, so no
// frontend change was needed), but the backfill starts over from scratch once on deploy, same
// "thin at first, growing toward the full 90 days" shape this cache has always had.
const DAYS_TO_KEEP = 90;
const CACHE_SCHEMA_VERSION = 2;
const BLOCKSCOUT_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const CACHE_INTERVAL_MS = process.env.DAILY_BLOCK_STATS_CACHE_INTERVAL_MS
  ? parseInt(process.env.DAILY_BLOCK_STATS_CACHE_INTERVAL_MS, 10)
  : 300000;
// 50 blocks/page, so 200 pages/cycle ≈ 10,000 blocks — a full 90-day backfill (~31,000 pages)
// takes roughly a day at the default cadence. Same conservative-by-default reasoning as
// validatorRewardsCache.js's identical knob: Blockscout's own rate limits for this volume of
// sequential requests aren't documented anywhere.
const MAX_PAGES_PER_CYCLE = process.env.DAILY_BLOCK_STATS_MAX_PAGES_PER_CYCLE
  ? parseInt(process.env.DAILY_BLOCK_STATS_MAX_PAGES_PER_CYCLE, 10)
  : 200;
const PAGE_DELAY_MS = process.env.DAILY_BLOCK_STATS_PAGE_DELAY_MS
  ? parseInt(process.env.DAILY_BLOCK_STATS_PAGE_DELAY_MS, 10)
  : 150;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Identical shape/reasoning to validatorRewardsCache.js's own fetchBlocksPage — duplicated rather
// than shared, same "fine to drift independently" philosophy this repo's other scanner pairs use.
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
// the page (and every page after it) is strictly time-descending.
function applyPageBlocks(days, items, cutoffDate) {
  for (const block of items) {
    const dayKey = String(block.timestamp).slice(0, 10);
    if (dayKey < cutoffDate) return { crossedCutoff: true };

    const miner = String(block.miner?.hash || "").toLowerCase();
    const txCount = Number(block.transaction_count) || 0;

    const day = days[dayKey] || (days[dayKey] = { txCount: 0, blockCount: 0, validators: {} });
    day.txCount += txCount;
    day.blockCount += 1;
    day.validators[miner] = (day.validators[miner] || 0) + 1;
  }
  return { crossedCutoff: false };
}

let isRunning = false;

async function scanAndPublish() {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getDailyBlockStatsCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const days = cached?.days ? { ...cached.days } : {};
    let highScannedBlock = cached?.highScannedBlock ?? null;
    let lowCursorParams = cached?.lowCursorParams; // undefined: not yet started; object: mid-backfill; null: complete

    const cutoffDate = new Date(Date.now() - DAYS_TO_KEEP * 86400000).toISOString().slice(0, 10);

    if (highScannedBlock == null) {
      // First run ever — one bounded walk back from the chain tip covers both "today's numbers
      // exist immediately" and seeds lowCursorParams for future backfill cycles, same
      // "recency over completeness" reasoning as nftSalesCache.js.
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

    // Self-pruning — oldest drops off first, by calendar date.
    for (const day of Object.keys(days)) {
      if (day < cutoffDate) delete days[day];
    }

    await setDailyBlockStatsCache({ days, highScannedBlock, lowCursorParams, schemaVersion: CACHE_SCHEMA_VERSION });

    const backfillDone = lowCursorParams === null;
    console.log(`📅 Daily block stats cache updated — ${Object.keys(days).length} day(s) tracked, backfill ${backfillDone ? "complete" : "in progress"}, caught up to block ${highScannedBlock}`);
  } catch (err) {
    console.error("⚠️  Daily block stats scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches. No longer needs an RPC provider at all — see the file's header comment.
 */
export function startDailyBlockStatsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — daily block stats cache disabled");
    return;
  }

  console.log(`📅 Daily block stats cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish();
  setInterval(scanAndPublish, CACHE_INTERVAL_MS);
}
