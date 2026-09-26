import { query } from "./pool.js";

// See migrations/019_pnl_snapshot_cache.sql's own header comment.

export async function getPersistedPnlSnapshot(cacheKey) {
  const res = await query(`SELECT payload, computed_at FROM pnl_snapshot_cache WHERE cache_key = $1`, [cacheKey]);
  const row = res?.rows?.[0];
  return row ? { payload: row.payload, computedAt: row.computed_at } : null;
}

export async function upsertPersistedPnlSnapshot(cacheKey, payload) {
  await query(
    `INSERT INTO pnl_snapshot_cache (cache_key, payload, computed_at) VALUES ($1, $2, now())
     ON CONFLICT (cache_key) DO UPDATE SET payload = $2, computed_at = now()`,
    [cacheKey, JSON.stringify(payload)]
  );
}
