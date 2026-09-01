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
import { getBackfillState, markBackfilled } from "../db/priceHistoryBackfillState.js";

const NETWORK = "electroneum";
// Same wrapped-Electroneum address tokenChartRouter.js prefers pools against — see that file's
// own comment for why WETN pricing (not raw USD-reserve ranking) is what this app treats as
// canonical, and why ETN's own historical price is derived from WETN pools (ETN/WETN are 1:1
// pegged; GeckoTerminal indexes the wrapped pools, not native ETN transfers).
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const NATIVE_SENTINEL = "NATIVE";

// Bucket historical price lookups to the DAY — both underlying sources only ever resolve to day
// granularity anyway (fetchNearestCandleUsd queries GeckoTerminal's /ohlcv/day endpoint;
// fetchCoinGeckoHistoricalEtnUsd's date=dd-mm-yyyy param has no time component), so bucketing any
// finer than a day was pure waste: a wallet with several transactions on the same calendar day but
// different hours was triggering a separate fresh external lookup — and separate rate-limit
// pressure — per hour, for an answer that would've been byte-identical. Confirmed live: this is
// what was driving the GeckoTerminal/CoinGecko 429 storm on a single busy wallet's first-ever
// statement. Bucketing to the day is a strict improvement — same or better cache hit rate, zero
// accuracy loss, since neither source could tell two same-day timestamps apart regardless.
function bucketToDay(timestamp) {
  const d = new Date(timestamp);
  d.setUTCHours(0, 0, 0, 0);
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

/** Walks one pool's ENTIRE available daily OHLCV history backward (paginating via
 * before_timestamp until an empty page — GeckoTerminal simply stops returning candles once it
 * runs out, which for these pools means "back to the pool's own creation", not any fixed window),
 * upserting every day into price_points. Turns "one live lookup per transaction date" into "one
 * bulk fetch, ever, per pool" — a handful of paginated calls through the existing shared
 * rate-limited queue instead of potentially hundreds of individual ones. Returns the earliest date
 * actually reached (or null if the pool had no candles at all). */
async function backfillPoolDailyHistory(poolAddress, tokenIsBase, cacheAsset) {
  const tokenSide = tokenIsBase ? "base" : "quote";
  let beforeTs = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
  let earliestDate = null;
  // 20 pages * up to 1000 daily candles/page = room for ~54 years — nowhere close to being hit in
  // practice, purely a safety ceiling against an unbounded loop if the API ever behaves
  // unexpectedly (e.g. before_timestamp not actually advancing).
  for (let page = 0; page < 20; page++) {
    let res;
    try {
      res = await fetchGeckoTerminal(
        `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${tokenSide}&before_timestamp=${beforeTs}`
      );
    } catch (err) {
      console.warn(`⚠️  Price backfill: OHLCV page fetch failed for pool ${poolAddress}:`, err.message);
      break;
    }
    const list = res.data?.attributes?.ohlcv_list || [];
    if (list.length === 0) break;

    let oldestSecThisPage = Infinity;
    for (const [sec, , , , close] of list) {
      const day = new Date(sec * 1000);
      day.setUTCHours(0, 0, 0, 0);
      await upsertPricePoint(cacheAsset, day, Number(close), "geckoterminal-backfill");
      if (!earliestDate || day < earliestDate) earliestDate = day;
      if (sec < oldestSecThisPage) oldestSecThisPage = sec;
    }
    // Order isn't documented either way for this endpoint, so page by the oldest timestamp seen
    // in the page rather than assuming ascending/descending — safe regardless. Stop once a page
    // can't move the cursor further back (a short/empty-progress page means we've hit the start).
    if (list.length < 1000 || oldestSecThisPage >= beforeTs) break;
    beforeTs = oldestSecThisPage;
  }
  return earliestDate;
}

/** Bulk-backfills an asset's full available on-chain price history across EVERY relevant pool, not
 * just the single highest-liquidity one resolvePoolAddress() would pick for a live lookup — oldest
 * pool first, so a since-superseded-but-older pool can still cover dates the current best pool
 * predates. Later (generally more liquid, more current) pools' prices overwrite any overlapping
 * days via upsertPricePoint's ON CONFLICT, so the most trustworthy source wins wherever multiple
 * pools cover the same date, while genuinely older days only an older pool ever covers are kept
 * rather than left blank. */
async function backfillAssetPriceHistory(cacheAsset, tokenAddress) {
  const key = tokenAddress.toLowerCase();
  let pools = [];
  try {
    const res = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${key}/pools`);
    pools = res.data || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (pools.length === 0) return { earliestDate: null, poolCount: 0 };

  const tokenId = `${NETWORK}_${key}`;
  const wetnId = `${NETWORK}_${WETN_ADDRESS}`;
  const wetnPools = pools.filter((p) => {
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const otherId = baseId === tokenId ? quoteId : baseId;
    return otherId === wetnId;
  });
  const candidates = wetnPools.length > 0 ? wetnPools : pools;
  const sorted = [...candidates].sort(
    (a, b) => new Date(a.attributes.pool_created_at) - new Date(b.attributes.pool_created_at)
  );

  let earliestDate = null;
  for (const pool of sorted) {
    const tokenIsBase = pool.relationships?.base_token?.data?.id === tokenId;
    const poolEarliest = await backfillPoolDailyHistory(pool.attributes.address, tokenIsBase, cacheAsset);
    if (poolEarliest && (!earliestDate || poolEarliest < earliestDate)) earliestDate = poolEarliest;
  }
  return { earliestDate, poolCount: sorted.length };
}

/** Runs backfillAssetPriceHistory exactly once, ever, per asset — recorded in
 * price_history_backfill_state. Every getHistoricalPriceUsd call routes through this first, so the
 * very first lookup for a brand-new asset triggers the bulk fetch (a handful of calls) and every
 * lookup after that — for that date or any other, in this statement or a future one — is a pure
 * price_points cache read. A failed backfill attempt is NOT recorded as done, so it's retried on
 * the next call rather than permanently giving up. */
async function ensureBackfilled(cacheAsset, tokenAddress) {
  const state = await getBackfillState(cacheAsset);
  if (state) return state;

  try {
    const { earliestDate, poolCount } = await backfillAssetPriceHistory(cacheAsset, tokenAddress);
    await markBackfilled(cacheAsset, { earliestAvailableDate: earliestDate, poolCount });
    console.log(
      `💰 Price history backfilled for ${cacheAsset}: earliest available ${earliestDate ? earliestDate.toISOString().slice(0, 10) : "none found"}, ${poolCount} pool(s) scanned`
    );
  } catch (err) {
    console.warn(`⚠️  Price history backfill failed for ${cacheAsset}, falling back to per-date lookups:`, err.message);
  }
}

/** Earliest date this asset actually has real price data for, per its recorded backfill — null if
 * never backfilled yet or no history was found at all. Used to decide whether a statement's period
 * needs the "price data may be incomplete" disclaimer (see pnlStatementGenerator.js). */
export async function getEarliestAvailableDate(asset) {
  const isNative = asset === NATIVE_SENTINEL || asset.toUpperCase() === "ETN";
  const cacheAsset = isNative ? "ETN" : asset.toLowerCase();
  const state = await getBackfillState(cacheAsset);
  return state?.earliest_available_date ? new Date(state.earliest_available_date) : null;
}

// One bounded retry on 429, honoring Retry-After when CoinGecko sends it (else a flat 3s) — same
// "bounded retry, not a runaway loop" philosophy as tokenChartRouter.js's GeckoTerminal queue, but
// simpler: unlike that shared queue, this fallback path has no other callers to coordinate a
// cooldown with, so a plain per-call retry is enough. Previously this had zero resilience at all —
// a single transient 429 permanently gave up on that day's price.
async function fetchCoinGeckoHistoricalEtnUsd(timestamp, attempt = 0) {
  const dd = String(timestamp.getUTCDate()).padStart(2, "0");
  const mm = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = timestamp.getUTCFullYear();
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/electroneum/history?date=${dd}-${mm}-${yyyy}&localization=false`
  );
  if (res.status === 429 && attempt === 0) {
    const retryAfterSec = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 3000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fetchCoinGeckoHistoricalEtnUsd(timestamp, attempt + 1);
  }
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
  const bucketed = bucketToDay(timestamp);
  const tokenAddress = isNative ? WETN_ADDRESS : asset;

  await ensureBackfilled(cacheAsset, tokenAddress);

  const cached = await getPricePoint(cacheAsset, bucketed);
  if (cached) return Number(cached.price_usd);

  let priceUsd = null;
  let source = null;

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
