// backend/utils/priceTopUpScheduler.js
//
// Runs pnlPricing.js's topUpRecentPrices once per UTC day, after PRICE_TOPUP_HOUR_UTC (default
// 01:00) — well before pnlSnapshotScheduler.js's 13:00 run, so the day it fills in is already in
// price_points. Same tick-often-but-act-once-a-day shape as that scheduler. The last-run day is in
// memory only, so a restart re-runs it once that day; harmless (it upserts the same closes) and
// cheap.
import { getPool } from "../db/pool.js";
import { topUpRecentPrices } from "../services/pnlPricing.js";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const TOPUP_HOUR_UTC = process.env.PRICE_TOPUP_HOUR_UTC ? parseInt(process.env.PRICE_TOPUP_HOUR_UTC, 10) : 1;

let isRunning = false;
let lastRunDay = null;

async function tick() {
  if (isRunning) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (lastRunDay === today || now.getUTCHours() < TOPUP_HOUR_UTC) return;

  isRunning = true;
  try {
    const startedAt = Date.now();
    const r = await topUpRecentPrices();
    lastRunDay = today;
    console.log(
      `💱 Price top-up: ${r.updated}/${r.assets} assets updated, ${r.pricesWritten} daily prices written + ${r.carried} carried forward ` +
        `(${r.noData} no data, ${r.skipped} skipped, ${r.failed} failed) in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
  } catch (err) {
    console.error("⚠️  Price top-up failed:", err.message); // lastRunDay unset — the next tick retries
  } finally {
    isRunning = false;
  }
}

export function startPriceTopUpScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — price top-up scheduler disabled");
    return;
  }
  console.log(`💱 Price top-up scheduler started (daily after ${TOPUP_HOUR_UTC}:00 UTC)`);
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}
