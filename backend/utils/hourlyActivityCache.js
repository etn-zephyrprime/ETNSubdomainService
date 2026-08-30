import { ethers } from "ethers";
import { getHourlyActivityCache, setHourlyActivityCache } from "../state/hourlyActivityState.js";
import { createRpcProvider } from "./rpcProvider.js";

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
//
// Same RPC_URL note as dailyBlockStatsCache.js — full-transaction-object fetches are heavy enough
// that this cache needs a keyed endpoint too, not the bare public one. (RPC access itself goes
// through rpcProvider.js's createRpcProvider().)
const DAYS_TO_KEEP = 8; // 7 real days shown + 1 day buffer, same reasoning as dailyBlockStatsCache.js

// Also maintains a real rolling-7-day "top transactions by ETN value" leaderboard, for Overview.jsx's
// Top Transactions by ETN Volume panel — this cache already fetches every full transaction object
// in the window for the volume sums above, so tracking the highest-value ones alongside that costs
// zero extra RPC calls, just a bit more memory/CPU per cycle to keep a small sorted list. A
// streaming top-K, not a stored history: only TOP_TX_LIMIT entries are ever kept, re-merged and
// re-pruned (by age, a precise 7*86400000ms cutoff — not the looser 8-day-bucket one `hours` uses)
// every cycle, so this never grows unbounded the way naively storing every candidate would.
//
// Deliberately does NOT force a backfill to seed this retroactively — this cache's own backfill
// (if not already complete on a running deployment) only re-derives `hours`' aggregate sums, and
// re-scanning already-scanned blocks a second time just to extract individual transactions would
// double-count those sums unless `hours` were wiped and rebuilt from scratch too, which reintroduces
// exactly the RPC cost this whole feature is designed to avoid by reusing an existing scan. So this
// starts genuinely empty on a deployment that's already caught up, and grows into a real, complete
// rolling 7 days over the next 7 real days — same "starts thin, grows honestly" pattern this
// codebase uses elsewhere (see dashboardStatsCache.js) — `topTransactionsSinceMs` (set once, never
// changed) is what lets the frontend caption its actual current coverage instead of just... showing
// a suspiciously short list with no explanation.
const TOP_TX_LIMIT = 50; // well above what the UI shows by default (10) or reasonably expands to
const TOP_TX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
    const timestampMs = timestamp * 1000;
    const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
    let valueWei = 0n;
    // Zero-value entries (contract calls, approvals, etc.) can never place on a by-value
    // leaderboard, so they're dropped here rather than carried through only to lose a sort later.
    const txCandidates = [];
    for (const tx of transactions) {
      let v = 0n;
      try {
        v = BigInt(tx.value || "0x0");
      } catch {
        // malformed value on one tx shouldn't drop the whole block's count — just skip its value
      }
      valueWei += v;
      if (v > 0n) {
        txCandidates.push({ hash: tx.hash, from: tx.from, to: tx.to, valueWei: v.toString(), timestampMs });
      }
    }
    return { hourKey: hourKeyFromTimestamp(timestamp), txCount: transactions.length, valueWei, txCandidates };
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

// Keeps only the top `limit` by value across `current` (already-ranked) and `incoming` (this
// batch's new candidates) — a plain sort-and-slice, not an incremental insert, since `current` is
// never more than TOP_TX_LIMIT items and `incoming` is bounded by one scan batch, so the combined
// size this runs against stays small regardless of how much real transaction volume this chain
// sees over time.
function mergeTopTransactions(current, incoming, limit) {
  if (incoming.length === 0) return current;
  const merged = [...current, ...incoming];
  merged.sort((a, b) => {
    const av = BigInt(a.valueWei);
    const bv = BigInt(b.valueWei);
    return bv > av ? 1 : bv < av ? -1 : 0;
  });
  return merged.slice(0, limit);
}

function applyResults(hours, results, topTransactions) {
  let merged = topTransactions;
  for (const r of results) {
    if (!r) continue;
    const bucket = hours[r.hourKey] || (hours[r.hourKey] = { txCount: 0, etnVolumeWei: "0" });
    bucket.txCount += r.txCount;
    bucket.etnVolumeWei = (BigInt(bucket.etnVolumeWei) + r.valueWei).toString();
    merged = mergeTopTransactions(merged, r.txCandidates, TOP_TX_LIMIT);
  }
  return merged;
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
    let topTransactions = cached?.topTransactions ? [...cached.topTransactions] : [];
    // Set once, on this feature's genuine first run, and never touched again — the frontend's only
    // way to know how much of a real rolling 7 days topTransactions actually covers right now
    // (see the const's own comment above for why this can't just be backfilled).
    const topTransactionsSinceMs = cached?.topTransactionsSinceMs ?? Date.now();

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
      topTransactions = applyResults(hours, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY), topTransactions);
      highScannedBlock = latestBlock;
      lowScannedBlock = fromBlock;
    } else {
      if (latestBlock > highScannedBlock) {
        const fromBlock = highScannedBlock + 1;
        topTransactions = applyResults(hours, await scanBlockRange(provider, fromBlock, latestBlock, CONCURRENCY), topTransactions);
        highScannedBlock = latestBlock;
      }
      if (lowScannedBlock > floorBlock) {
        const toBlock = lowScannedBlock - 1;
        const fromBlock = Math.max(floorBlock, toBlock - MAX_BLOCKS_PER_CYCLE + 1);
        topTransactions = applyResults(hours, await scanBlockRange(provider, fromBlock, toBlock, CONCURRENCY), topTransactions);
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

    // Own, tighter, precise-to-the-millisecond cutoff — topTransactions is a genuine rolling 7
    // days, not the looser 8-day-bucket-with-buffer window `hours` above keeps.
    const topTxCutoffMs = Date.now() - TOP_TX_WINDOW_MS;
    topTransactions = topTransactions.filter((tx) => tx.timestampMs >= topTxCutoffMs);

    await setHourlyActivityCache({
      hours,
      lowScannedBlock,
      highScannedBlock,
      floorBlock,
      topTransactions,
      topTransactionsSinceMs,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    const topTxCoverageDays = Math.min(7, (Date.now() - topTransactionsSinceMs) / 86400000).toFixed(1);
    console.log(`⏱️  Hourly activity cache updated — ${Object.keys(hours).length} hour(s) tracked, ${topTransactions.length} top transaction(s) (${topTxCoverageDays}/7 days coverage), caught up to block ${highScannedBlock}`);
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

  const provider = createRpcProvider({ batchMaxCount: 1 });

  console.log(`⏱️  Hourly activity cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(provider);
  setInterval(() => scanAndPublish(provider), CACHE_INTERVAL_MS);
}
