import { query } from "./pool.js";

// See migrations/002_price_history_backfill_state.sql — one row per asset, ever, marking that its
// full available on-chain history has already been bulk-fetched into price_points.

export async function getBackfillState(asset) {
  const res = await query("SELECT * FROM price_history_backfill_state WHERE asset = $1", [asset]);
  return res?.rows[0] || null;
}

export async function markBackfilled(asset, { earliestAvailableDate, poolCount }) {
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
