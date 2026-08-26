import { getDashboardStatsCache, setDashboardStatsCache } from "../state/dashboardStatsState.js";

// Snapshots Electroneum's Blockscout /stats once an hour and keeps a rolling window in R2, so the
// dashboard's Overview tab can chart Total Addresses / Total Blocks / Avg Block Time / Gas Price
// over time — see dashboardStatsState.js's header comment for why this exists at all (no
// Blockscout endpoint has this history). Total Transactions is NOT tracked here even though it's
// also chartable on Overview — it's derived client-side from the real ~90-day daily series
// /stats/charts/transactions already provides (richer, immediately, no cold start needed), see
// src/dashboard/hooks/useDashboardStats.js.
const BLOCKSCOUT_STATS_URL = process.env.BLOCKSCOUT_STATS_URL || "https://blockexplorer.electroneum.com/api/v2/stats";
const CACHE_INTERVAL_MS = process.env.DASHBOARD_STATS_CACHE_INTERVAL_MS
  ? parseInt(process.env.DASHBOARD_STATS_CACHE_INTERVAL_MS, 10)
  : 60 * 60 * 1000; // hourly — matches "Txs Today, charted by the hour"'s granularity
// 30 days of hourly snapshots. Bounds the published file's size regardless of how long this has
// been running, same reasoning as every other rolling-window cache in this backend.
const MAX_SNAPSHOTS = process.env.DASHBOARD_STATS_MAX_SNAPSHOTS
  ? parseInt(process.env.DASHBOARD_STATS_MAX_SNAPSHOTS, 10)
  : 24 * 30;

let isRunning = false;

async function snapshotAndPublish() {
  if (isRunning) return; // previous snapshot still in flight — skip this tick
  isRunning = true;
  try {
    const res = await fetch(BLOCKSCOUT_STATS_URL);
    if (!res.ok) throw new Error(`Blockscout /stats returned ${res.status}`);
    const stats = await res.json();

    const { snapshots } = await getDashboardStatsCache();
    const previous = snapshots[snapshots.length - 1] || null;
    const transactionsToday = Number(stats.transactions_today) || 0;

    // How many transactions landed since the last snapshot, *within the same calendar day* —
    // transactions_today resets to 0 at UTC midnight, so a drop from the previous snapshot means
    // the day rolled over sometime in between; treat that as "today's count so far" rather than
    // a negative delta. This is what makes an hourly bar chart of "Txs Today" meaningful instead
    // of just re-plotting the same ever-growing daily total 24 times.
    const transactionsThisHour = previous && transactionsToday >= previous.transactionsToday
      ? transactionsToday - previous.transactionsToday
      : transactionsToday;

    const snapshot = {
      timestamp: new Date().toISOString(),
      totalTransactions: Number(stats.total_transactions) || 0,
      totalAddresses: Number(stats.total_addresses) || 0,
      totalBlocks: Number(stats.total_blocks) || 0,
      averageBlockTimeMs: Number(stats.average_block_time) || 0,
      gasPriceAverage: Number(stats.gas_prices?.average) || 0,
      transactionsToday,
      transactionsThisHour,
    };

    const updated = [...snapshots, snapshot].slice(-MAX_SNAPSHOTS);
    await setDashboardStatsCache(updated);
    console.log(`📊 Dashboard stats snapshot published — ${updated.length} point(s) in the rolling window`);
  } catch (err) {
    console.error("⚠️  Dashboard stats snapshot failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background snapshotter. No-op if R2 isn't configured, same as this repo's other
 * caches — there'd be nowhere public to publish to.
 */
export function startDashboardStatsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — dashboard stats history cache disabled");
    return;
  }

  console.log(`📊 Dashboard stats history cache started (snapshotting every ${CACHE_INTERVAL_MS / 1000}s)`);
  snapshotAndPublish();
  setInterval(snapshotAndPublish, CACHE_INTERVAL_MS);
}
