// backend/services/pnlPricing.js
//
// Resolves the USD price of ETN or a token at a specific historical timestamp — needed at the
// time of every inflow/outflow to compute cost basis and proceeds (see the PnL statement build
// brief). Reuses tokenChartRouter.js's shared, rate-limited GeckoTerminal queue (fetchGeckoTerminal)
// rather than running a second independent limiter against the same GeckoTerminal budget — see
// that export's own comment for why sharing the queue is a correctness requirement here, not just
// a style choice. Falls back to CoinGecko's historical-by-date endpoint for plain ETN/USD when no
// relevant GeckoTerminal pool candle exists.
//
// TESTNET CAVEAT: GeckoTerminal is a mainnet indexer product — it will never index the testnet
// MockRouter/MockCoreToken pair used for the buy-and-burn lifecycle tests (see the PnL statement
// build plan's testnet-first section). PNL_PRICING_TESTNET_STUB_USD, if set, short-circuits every
// price lookup to a fixed value so the pricing plumbing itself (caching, FIFO cost-basis math) can
// still be exercised end-to-end on testnet without real market data.
import { fetchGeckoTerminal } from "../utils/tokenChartRouter.js";
import { getPricePoint, upsertPricePoint } from "../db/pricePoints.js";

const NETWORK = "electroneum";
// Same wrapped-Electroneum address tokenChartRouter.js prefers pools against — see that file's
// own comment for why WETN pricing (not raw USD-reserve ranking) is what this app treats as
// canonical, and why ETN's own historical price is derived from WETN pools (ETN/WETN are 1:1
// pegged; GeckoTerminal indexes the wrapped pools, not native ETN transfers).
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const NATIVE_SENTINEL = "NATIVE";

// Bucket historical price lookups to the hour — a PnL statement's cost-basis accuracy doesn't
// need sub-hour precision, and this is what makes repeat lookups for the same rough time actually
// hit the price_points cache (backend/db/pricePoints.js) instead of missing on exact-millisecond
// differences between two events in the same trading session.
function bucketToHour(timestamp) {
  const d = new Date(timestamp);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

const poolCache = new Map(); // tokenAddress -> { poolAddress, tokenIsBase } (best WETN-paired pool), or null if none found
const POOL_CACHE_TTL_MS = 15 * 60 * 1000;
const poolCacheExpiry = new Map();

async function resolvePoolAddress(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  const expiry = poolCacheExpiry.get(key);
  if (expiry && expiry > Date.now()) return poolCache.get(key);

  let pools = [];
  try {
    const res = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${key}/pools`);
    pools = res.data || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const tokenId = `${NETWORK}_${key}`;
  const wetnId = `${NETWORK}_${WETN_ADDRESS}`;
  const wetnPools = pools.filter((p) => {
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const otherId = baseId === tokenId ? quoteId : baseId;
    return otherId === wetnId;
  });
  const candidates = wetnPools.length > 0 ? wetnPools : pools;
  const best = candidates.length
    ? candidates.reduce((a, b) => (Number(b.attributes.reserve_in_usd || 0) > Number(a.attributes.reserve_in_usd || 0) ? b : a))
    : null;

  const result = best
    ? { poolAddress: best.attributes.address, tokenIsBase: best.relationships?.base_token?.data?.id === tokenId }
    : null;
  poolCache.set(key, result);
  poolCacheExpiry.set(key, Date.now() + POOL_CACHE_TTL_MS);
  return result;
}

// Finds the daily candle closest to `timestamp` via GeckoTerminal's OHLCV endpoint, anchored with
// before_timestamp so the fetch is centered near the target date rather than always returning the
// most recent data. NOTE: before_timestamp is GeckoTerminal's documented pagination parameter for
// this endpoint as of when this was written — worth a quick empirical spot-check against a real
// pool during implementation if a lookup ever silently returns "no candle" for a date that should
// have trading activity, in case the API has changed.
async function fetchNearestCandleUsd(poolAddress, tokenIsBase, timestamp) {
  const beforeTs = Math.floor(timestamp.getTime() / 1000) + 3 * 24 * 60 * 60; // pad a few days later so the target date isn't right at the edge of the page
  const tokenSide = tokenIsBase ? "base" : "quote";
  const res = await fetchGeckoTerminal(
    `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${tokenSide}&before_timestamp=${beforeTs}`
  );
  const list = res.data?.attributes?.ohlcv_list || [];
  if (list.length === 0) return null;

  const targetSec = Math.floor(timestamp.getTime() / 1000);
  let closest = null;
  let closestDelta = Infinity;
  for (const [sec, , , , close] of list) {
    const delta = Math.abs(sec - targetSec);
    if (delta < closestDelta) {
      closestDelta = delta;
      closest = close;
    }
  }
  // More than 3 days from the nearest candle isn't a meaningful price for this timestamp — likely
  // a thinly-traded pool with a gap, not real data for the date in question (GeckoTerminal omits
  // zero-trade candles entirely rather than carrying the last price forward — see
  // tokenChartRouter.js's own comment on this exact behavior).
  if (closestDelta > 3 * 24 * 60 * 60) return null;
  return Number(closest);
}

async function fetchCoinGeckoHistoricalEtnUsd(timestamp) {
  const dd = String(timestamp.getUTCDate()).padStart(2, "0");
  const mm = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = timestamp.getUTCFullYear();
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/electroneum/history?date=${dd}-${mm}-${yyyy}&localization=false`
  );
  if (!res.ok) throw new Error(`CoinGecko history returned ${res.status}`);
  const json = await res.json();
  const usd = json?.market_data?.current_price?.usd;
  if (typeof usd !== "number") throw new Error("CoinGecko history response missing market_data.current_price.usd");
  return usd;
}

/** Resolves the USD price of `asset` ('NATIVE'/'ETN', or a token address) at `timestamp`, caching
 * the result in price_points. Throws if no price could be resolved — callers decide how to handle
 * that (the FIFO engine treats an unresolvable price as a data gap to flag, not to silently zero). */
export async function getHistoricalPriceUsd(asset, timestamp) {
  if (process.env.PNL_PRICING_TESTNET_STUB_USD) {
    return Number(process.env.PNL_PRICING_TESTNET_STUB_USD);
  }

  const isNative = asset === NATIVE_SENTINEL || asset.toUpperCase() === "ETN";
  const cacheAsset = isNative ? "ETN" : asset.toLowerCase();
  const bucketed = bucketToHour(timestamp);

  const cached = await getPricePoint(cacheAsset, bucketed);
  if (cached) return Number(cached.price_usd);

  let priceUsd = null;
  let source = null;

  const tokenAddress = isNative ? WETN_ADDRESS : asset;
  try {
    const pool = await resolvePoolAddress(tokenAddress);
    if (pool) {
      priceUsd = await fetchNearestCandleUsd(pool.poolAddress, pool.tokenIsBase, bucketed);
      if (priceUsd != null) source = "geckoterminal";
    }
  } catch (err) {
    console.warn(`⚠️  GeckoTerminal historical price lookup failed for ${cacheAsset} @ ${bucketed.toISOString()}:`, err.message);
  }

  if (priceUsd == null && isNative) {
    try {
      priceUsd = await fetchCoinGeckoHistoricalEtnUsd(bucketed);
      source = "coingecko";
    } catch (err) {
      console.warn(`⚠️  CoinGecko historical ETN price lookup failed for ${bucketed.toISOString()}:`, err.message);
    }
  }

  if (priceUsd == null) {
    throw new Error(`Could not resolve historical USD price for ${cacheAsset} at ${bucketed.toISOString()}`);
  }

  await upsertPricePoint(cacheAsset, bucketed, priceUsd, source);
  return priceUsd;
}
