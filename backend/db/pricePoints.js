import { query } from "./pool.js";

// Cache in front of the live price source (GeckoTerminal/CoinGecko — see pnlPricing.js). Exact
// timestamp keying: pnlPricing.js is responsible for rounding/bucketing timestamps before calling
// these so repeat lookups for "close enough" times actually hit the cache instead of missing on
// sub-second differences.

export async function getPricePoint(asset, timestamp) {
  const res = await query("SELECT * FROM price_points WHERE asset = $1 AND \"timestamp\" = $2", [
    asset,
    timestamp,
  ]);
  return res?.rows[0] || null;
}

export async function upsertPricePoint(asset, timestamp, priceUsd, source) {
  await query(
    `INSERT INTO price_points (asset, "timestamp", price_usd, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (asset, "timestamp") DO UPDATE SET price_usd = EXCLUDED.price_usd, source = EXCLUDED.source`,
    [asset, timestamp, priceUsd, source]
  );
}

/** Every cached price point for `asset` from `sinceTimestamp` onward (inclusive), oldest first.
 * Powers the dashboard's long-range ETN price chart (see tokenChartRouter.js) — unlike
 * getPricePoint above, this is a genuine range scan, not an exact-timestamp cache lookup, so it's
 * fine for this to return a lot of rows (one per day covers 2019-to-now in ~2,600 rows). */
export async function getPricePointsSince(asset, sinceTimestamp) {
  const res = await query(
    `SELECT "timestamp", price_usd FROM price_points WHERE asset = $1 AND "timestamp" >= $2 ORDER BY "timestamp" ASC`,
    [asset, sinceTimestamp]
  );
  return res?.rows || [];
}
