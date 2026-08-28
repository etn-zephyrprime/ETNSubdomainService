import { ethers } from "ethers";
import { getDailyBlockStatsCache, setDailyBlockStatsCache } from "../state/dailyBlockStatsState.js";

// Keeps a public JSON cache of real per-UTC-day transaction counts and validator (miner)
// block-production breakdowns for the last ~90 days — powers Overview.jsx's "Total Transactions"
// chart (a genuine 90-day view, not Blockscout's 31-day-capped one) and its "Total Blocks"
// heatmap (cell brightness = that day's tx count, tooltip = which validators produced blocks that
// day). Neither figure exists anywhere else: Blockscout's own `/stats/charts/transactions` only
// keeps 31 real days (confirmed live), and it has no validator/miner breakdown at all, for any
// day — this backend is the only place either could come from, same "Blockscout doesn't track
// this, so scan it ourselves" reasoning as nftSalesCache.js / nameServiceStatsCache.js.
//
// One real cost worth being upfront about: getting a *real* day's tx count means visiting every
// block that day (there's no running per-day counter anywhere — total_transactions is a single
// current total, not a per-day series, and RPC has no "transactions in this time range" query).
// At ~17,280 blocks/day, 90 days is ~1.5M individual block fetches — the heaviest one-time
// backfill in this codebase (bigger even than nftSalesCache.js's ~10M-block range, since that one
// only touches Seaport's own log events, not every single block). Kept lightweight per call
// (`eth_getBlockByNumber(n, false)` — hashes only, not full tx objects) and, like nftSalesCache.js,
// dual-cursor: `highScannedBlock` stays caught up to chain tip every cycle so *today's* numbers
// are never stale, while `lowScannedBlock` backfills the other 89 days in the background,
// bounded per cycle so it never floods the RPC — just takes several hours to fully catch up.
//
// Deliberately its own RPC endpoint, not this repo's shared RPC_URL (rpc.ankr.com/electroneum) —
// this cache's ~1.5M-block backfill was, on its own, enough to trip that endpoint's free-tier
// call-rate limit and start starving every other cache/watcher sharing it (see hourlyActivityCache.js,
// the other cache split the same way). Defaults to thirdweb's public endpoint instead so this
// scanner draws from an independent rate-limit budget rather than competing with the rest of the
// backend's steady-state polling for the same one.
const RPC_URL = process.env.DAILY_BLOCK_STATS_RPC_URL || "https://52014.rpc.thirdweb.com";
const DAYS_TO_KEEP = 90;
const CACHE_SCHEMA_VERSION = 1;
const CACHE_INTERVAL_MS = process.env.DAILY_BLOCK_STATS_CACHE_INTERVAL_MS
  ? parseInt(process.env.DAILY_BLOCK_STATS_CACHE_INTERVAL_MS, 10)
  : 300000;
const MAX_BLOCKS_PER_CYCLE = process.env.DAILY_BLOCK_STATS_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.DAILY_BLOCK_STATS_MAX_BLOCKS_PER_CYCLE, 10)
  : 20000;
// Conservative on purpose — this is ~1.5M individual RPC calls total, not the handful of
// getLogs-filter calls this repo's other scanners make; a public rate-limited RPC endpoint
// tolerates far fewer concurrent simple requests than it does a couple of chunked log queries.
const CONCURRENCY = process.env.DAILY_BLOCK_STATS_CONCURRENCY
  ? parseInt(process.env.DAILY_BLOCK_STATS_CONCURRENCY, 10)
  : 15;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dayKeyFromTimestamp(timestampSec) {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10); // "2026-08-28"
}

async function fetchBlockWithRetry(provider, blockNumber, attempt = 0) {
  try {
    const raw = await provider.send("eth_getBlockByNumber", [ethers.toBeHex(blockNumber), false]);
    if (!raw) return null;
    const timestamp = parseInt(raw.timestamp, 16);
    return {
      dayKey: dayKeyFromTimestamp(timestamp),
      miner: String(raw.miner || "").toLowerCase(),
      txCount: Array.isArray(raw.transactions) ? raw.transactions.length : 0,
    };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchBlockWithRetry(provider, blockNumber, attempt + 1);
    }
    console.warn(`⚠️  Daily block stats: failed to fetch block ${blockNumber} after retries:`, err.message);
    return null;
  }
}

async function scanBlockRange(provider, fromBlock, toBlock, concurrency) {
  const total = toBlock - fromBlock + 1;
  if (total <= 0) return [];
  const results = new Array(total);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      results[i] = await fetchBlockWithRetry(provider, fromBlock + i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return results;
}

function applyResults(days, results) {
  for (const r of results) {
    if (!r) continue;
    const day = days[r.dayKey] || (days[r.dayKey] = { txCount: 0, blockCount: 0, validators: {} });
    day.txCount += r.txCount;
    day.blockCount += 1;
    day.validators[r.miner] = (day.validators[r.miner] || 0) + 1;
  }
}

// One-time binary search for the earliest block at/after (now - (daysToKeep+1) days) — a few
// dozen sequential RPC calls (each depends on the previous), done once and persisted as
// `floorBlock` so it's never repeated. The +1 day buffer means the oldest UTC day is never
// missing its very first blocks just because the floor landed a few hours into it.
async function findFloorBlock(provider, latestBlock, daysToKeep) {
  const targetTs = Math.floor(Date.now() / 1000) - (daysToKeep + 1) * 86400;
  let lo = 0;
  let hi = latestBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await provider.getBlock(mid);
    if (!block || block.timestamp < targetTs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

let isRunning = false;

async function scanAndPublish(provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getDailyBlockStatsCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const days = cached?.days ? { ...cached.days } : {};

    const latestBlock = await provider.getBlockNumber();
    const floorBlock = cached?.floorBlock ?? (await findFloorBlock(provider, latestBlock, DAYS_TO_KEEP));

    let highScannedBlock = cached?.highScannedBlock ?? null;
    let lowScannedBlock = cached?.lowScannedBlock ?? null;

    if (highScannedBlock == null) {
      // First run ever — scan the most recent window first so today's numbers exist immediately,
      // same "recency over completeness" reasoning as nftSalesCache.js.
      const fromBlock = Math.max(floorBlock, latestBlock - MAX_BLOCKS_PER_CYCLE + 1);
      applyResults(days, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY));
      highScannedBlock = latestBlock;
      lowScannedBlock = fromBlock;
    } else {
      if (latestBlock > highScannedBlock) {
        const fromBlock = highScannedBlock + 1;
        applyResults(days, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY));
        highScannedBlock = latestBlock;
      }
      if (lowScannedBlock > floorBlock) {
        const toBlock = lowScannedBlock - 1;
        const fromBlock = Math.max(floorBlock, toBlock - MAX_BLOCKS_PER_CYCLE + 1);
        applyResults(days, await scanBlockRange(provider, fromBlock, toBlock, CONCURRENCY));
        lowScannedBlock = fromBlock;
      }
    }

    // Self-pruning — same "oldest drops off first" convention as this repo's other bounded
    // caches, just by calendar date instead of an array-length cap.
    const cutoffDate = new Date(Date.now() - DAYS_TO_KEEP * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(days)) {
      if (day < cutoffDate) delete days[day];
    }

    await setDailyBlockStatsCache({ days, lowScannedBlock, highScannedBlock, floorBlock, schemaVersion: CACHE_SCHEMA_VERSION });

    const totalRange = latestBlock - floorBlock || 1;
    const backfillPct = (((highScannedBlock - lowScannedBlock) / totalRange) * 100).toFixed(1);
    console.log(`📅 Daily block stats cache updated — ${Object.keys(days).length} day(s) tracked, history backfilled ${backfillPct}%, caught up to block ${highScannedBlock}`);
  } catch (err) {
    console.error("⚠️  Daily block stats scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startDailyBlockStatsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — daily block stats cache disabled");
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

  console.log(`📅 Daily block stats cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(provider);
  setInterval(() => scanAndPublish(provider), CACHE_INTERVAL_MS);
}
