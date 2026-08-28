import { ethers } from "ethers";
import { getHourlyActivityCache, setHourlyActivityCache } from "../state/hourlyActivityState.js";

// Keeps a public JSON cache of real per-UTC-hour transaction counts and ETN volume transferred,
// for a rolling last ~8 days — powers Overview.jsx's "Txs Last 7 Days" heatmap (cell brightness =
// that hour's tx count, tooltip = real ETN volume transferred that hour). Neither figure exists
// anywhere else: Blockscout's /stats has no per-hour history at all, and no running "total ETN
// transferred" counter to diff either (confirmed live — /stats has total_gas_used, not a value-
// transferred figure) — the only way to get a real number is summing every transaction's own
// `value` field, which means fetching full block objects (not just tx hashes, unlike
// dailyBlockStatsCache.js — a tx's value only exists on the full tx object, there's no lighter
// call that includes it).
//
// A *rolling* 8-day window, not a growing history like dailyBlockStatsCache.js's 90 days — the
// heatmap only ever shows the last 7 days, so there's no reason to keep — or pay the RPC cost of
// backfilling — anything older. Same dual-cursor shape as that file otherwise (tip stays fresh
// every cycle; backfill catches the rest up in the background), just against a much smaller total
// range (~8 days × 17,280 blocks/day ≈ 138K blocks vs. dailyBlockStatsCache.js's ~1.5M), so this
// one fully catches up in well under an hour rather than several.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const DAYS_TO_KEEP = 8; // 7 real days shown + 1 day buffer, same reasoning as dailyBlockStatsCache.js
const CACHE_SCHEMA_VERSION = 1;
const CACHE_INTERVAL_MS = process.env.HOURLY_ACTIVITY_CACHE_INTERVAL_MS
  ? parseInt(process.env.HOURLY_ACTIVITY_CACHE_INTERVAL_MS, 10)
  : 300000;
const MAX_BLOCKS_PER_CYCLE = process.env.HOURLY_ACTIVITY_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.HOURLY_ACTIVITY_MAX_BLOCKS_PER_CYCLE, 10)
  : 20000;
// Lower than dailyBlockStatsCache.js's — full transaction objects are meaningfully heavier
// payloads than hashes-only, per call.
const CONCURRENCY = process.env.HOURLY_ACTIVITY_CONCURRENCY
  ? parseInt(process.env.HOURLY_ACTIVITY_CONCURRENCY, 10)
  : 10;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hourKeyFromTimestamp(timestampSec) {
  return new Date(timestampSec * 1000).toISOString().slice(0, 13); // "2026-08-28T14"
}

async function fetchBlockWithRetry(provider, blockNumber, attempt = 0) {
  try {
    const raw = await provider.send("eth_getBlockByNumber", [ethers.toBeHex(blockNumber), true]);
    if (!raw) return null;
    const timestamp = parseInt(raw.timestamp, 16);
    const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
    let valueWei = 0n;
    for (const tx of transactions) {
      try {
        valueWei += BigInt(tx.value || "0x0");
      } catch {
        // malformed value on one tx shouldn't drop the whole block's count — just skip its value
      }
    }
    return { hourKey: hourKeyFromTimestamp(timestamp), txCount: transactions.length, valueWei };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchBlockWithRetry(provider, blockNumber, attempt + 1);
    }
    console.warn(`⚠️  Hourly activity: failed to fetch block ${blockNumber} after retries:`, err.message);
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

function applyResults(hours, results) {
  for (const r of results) {
    if (!r) continue;
    const bucket = hours[r.hourKey] || (hours[r.hourKey] = { txCount: 0, etnVolumeWei: "0" });
    bucket.txCount += r.txCount;
    bucket.etnVolumeWei = (BigInt(bucket.etnVolumeWei) + r.valueWei).toString();
  }
}

// Same one-time binary search as dailyBlockStatsCache.js's findFloorBlock, just against this
// cache's much smaller window.
async function findFloorBlock(provider, latestBlock, daysToKeep) {
  const targetTs = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
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
    const rawCached = await getHourlyActivityCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const hours = cached?.hours ? { ...cached.hours } : {};

    const latestBlock = await provider.getBlockNumber();
    // The floor slides forward every cycle (unlike dailyBlockStatsCache.js's fixed floor) — this
    // is a rolling window, not a growing history, so re-deriving it each run keeps it honest
    // relative to "now" instead of drifting stale. Cheap: same one-time-per-run binary search,
    // just done every cycle instead of once — a few dozen calls against a 300s cycle is noise.
    const floorBlock = await findFloorBlock(provider, latestBlock, DAYS_TO_KEEP);

    let highScannedBlock = cached?.highScannedBlock ?? null;
    let lowScannedBlock = cached?.lowScannedBlock ?? null;

    if (highScannedBlock == null) {
      const fromBlock = Math.max(floorBlock, latestBlock - MAX_BLOCKS_PER_CYCLE + 1);
      applyResults(hours, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY));
      highScannedBlock = latestBlock;
      lowScannedBlock = fromBlock;
    } else {
      if (latestBlock > highScannedBlock) {
        const fromBlock = highScannedBlock + 1;
        applyResults(hours, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY));
        highScannedBlock = latestBlock;
      }
      if (lowScannedBlock > floorBlock) {
        const toBlock = lowScannedBlock - 1;
        const fromBlock = Math.max(floorBlock, toBlock - MAX_BLOCKS_PER_CYCLE + 1);
        applyResults(hours, await scanBlockRange(provider, fromBlock, toBlock, CONCURRENCY));
        lowScannedBlock = fromBlock;
      }
      // The floor sliding forward means lowScannedBlock can end up *behind* the new floor after
      // enough cycles (yesterday's "oldest scanned" is now older than the window needs) — clamp
      // it back up so the backfill check above doesn't keep re-scanning blocks this cache is
      // about to prune anyway.
      if (lowScannedBlock < floorBlock) lowScannedBlock = floorBlock;
    }

    // Self-pruning by hour, same convention as dailyBlockStatsCache.js's by-day trim.
    const cutoffHour = new Date(Date.now() - DAYS_TO_KEEP * 86400000).toISOString().slice(0, 13);
    for (const hour of Object.keys(hours)) {
      if (hour < cutoffHour) delete hours[hour];
    }

    await setHourlyActivityCache({ hours, lowScannedBlock, highScannedBlock, floorBlock, schemaVersion: CACHE_SCHEMA_VERSION });

    console.log(`⏱️  Hourly activity cache updated — ${Object.keys(hours).length} hour(s) tracked, caught up to block ${highScannedBlock}`);
  } catch (err) {
    console.error("⚠️  Hourly activity scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startHourlyActivityCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — hourly activity cache disabled");
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

  console.log(`⏱️  Hourly activity cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(provider);
  setInterval(() => scanAndPublish(provider), CACHE_INTERVAL_MS);
}
