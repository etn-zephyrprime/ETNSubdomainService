import { query } from "./pool.js";

// Cache in front of the live price source (GeckoTerminal/CoinGecko — see pnlPricing.js). Exact
// timestamp keying: pnlPricing.js is responsible for rounding/bucketing timestamps before calling
// these so repeat lookups for "close enough" times actually hit the cache instead of missing on
// sub-second differences.

// In-memory memo of FOUND price points. Every replay, gas total and history backfill resolves one
// price per event/day/token through getHistoricalPriceUsd, and each resolution was TWO Postgres round
// trips (this lookup + price_history_backfill_state). Measured in production: ~7.3M single-row calls
// of each, about a third of all rows this database returned — pure egress for data that never changes:
// a stored day's price is frozen once recorded. Only hits are remembered (a miss triggers a live
// fetch + upsert, after which the next lookup finds it), and upsertPricePoint below refreshes the
// entry, so this can't serve a value older than what was last written by THIS process. Bounded so it
// can't grow without limit on a 512MB instance; oldest entries drop first.
const pricePointMemo = new Map(); // "asset|ms" -> row
const PRICE_POINT_MEMO_MAX = 60000;

function pricePointKey(asset, timestamp) {
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? `${asset}|${ms}` : null;
}

function rememberPricePoint(key, row) {
  if (!key) return;
  pricePointMemo.delete(key);
  pricePointMemo.set(key, row);
  if (pricePointMemo.size > PRICE_POINT_MEMO_MAX) pricePointMemo.delete(pricePointMemo.keys().next().value);
}

export async function getPricePoint(asset, timestamp) {
  const key = pricePointKey(asset, timestamp);
  if (key && pricePointMemo.has(key)) return pricePointMemo.get(key);
  const res = await query("SELECT * FROM price_points WHERE asset = $1 AND \"timestamp\" = $2", [
    asset,
    timestamp,
  ]);
  const row = res?.rows[0] || null;
  if (row) rememberPricePoint(key, row);
  return row;
}

export async function upsertPricePoint(asset, timestamp, priceUsd, source) {
  rememberPricePoint(pricePointKey(asset, timestamp), { asset, timestamp: new Date(timestamp), price_usd: priceUsd, source });
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
