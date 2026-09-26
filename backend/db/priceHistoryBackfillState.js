import { query } from "./pool.js";

// See migrations/002_price_history_backfill_state.sql — one row per asset, ever, marking that its
// full available on-chain history has already been bulk-fetched into price_points.

// A backfill is recorded exactly once per asset, ever (see this file's own header) — but getBackfillState
// was asked on EVERY single price lookup (pnlPricing.js's ensureBackfilled), ~7.3M one-row queries in
// production. A found row is remembered for BACKFILL_STATE_TTL_MS (short enough that a re-backfill's
// updated earliest_available_date is picked up soon, long enough to collapse the per-lookup storm);
// "not backfilled yet" (null) is never remembered, since that's what triggers a backfill attempt.
const BACKFILL_STATE_TTL_MS = 10 * 60 * 1000;
const backfillStateMemo = new Map(); // asset -> { row, at }

export async function getBackfillState(asset) {
  const hit = backfillStateMemo.get(asset);
  if (hit && Date.now() - hit.at < BACKFILL_STATE_TTL_MS) return hit.row;
  const res = await query("SELECT * FROM price_history_backfill_state WHERE asset = $1", [asset]);
  const row = res?.rows[0] || null;
  if (row) backfillStateMemo.set(asset, { row, at: Date.now() });
  return row;
}

export async function markBackfilled(asset, { earliestAvailableDate, poolCount }) {
  backfillStateMemo.delete(asset); // re-read the row this write is about to change
  await query(
    `INSERT INTO price_history_backfill_state (asset, earliest_available_date, pool_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (asset) DO UPDATE SET
       earliest_available_date = EXCLUDED.earliest_available_date,
       pool_count = EXCLUDED.pool_count,
       backfilled_at = now()`,
    [asset, earliestAvailableDate, poolCount]
  );
}
