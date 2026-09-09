// backend/services/pnlPricing.js
//
// Resolves the USD price of ETN or a token at a specific historical timestamp — needed at the
// time of every inflow/outflow to compute cost basis and proceeds (see the PnL statement build
// brief).
//
// PRICE SOURCES, in the order each asset actually uses them:
//  - Native ETN: KuCoin's public spot-market daily candles (ETN-USDT) — confirmed live this goes
//    back to the pair's real listing date, 2019-07-10, with NO rolling-window restriction (unlike
//    every "indexer product" tier below) since it's just KuCoin's own trading history, not a
//    third-party data product with a free/paid tier. This is the primary source for ETN. Checked
//    several other major exchanges too (Binance doesn't list ETN at all) before landing on KuCoin.
//  - Tokens (any ERC-20 on this chain, e.g. CORE): BOTH GeckoTerminal's on-chain OHLCV (via
//    tokenChartRouter.js's shared, rate-limited queue, fetchGeckoTerminal) AND ElectroSwap's own
//    official API candles endpoint (electroSwapApi.js's getCandles) are queried, merged to the
//    wider combined range. Originally this tried ElectroSwap first and skipped GeckoTerminal
//    entirely on success — reverted after confirming live that GeckoTerminal's OHLCV ceiling isn't
//    a rolling window (an earlier comment here, based on a one-time "184 days" measurement, assumed
//    it was) but a FIXED historical floor from whenever GeckoTerminal started indexing a given pool
//    — so it grows in apparent "days back" over real time and can, for a pool GeckoTerminal has
//    indexed a long while, reach further back than ElectroSwap's own ~500-day/since-pool-creation
//    ceiling. Real production data proved this for WETN specifically: GeckoTerminal (20 pools) had
//    already reached 2025-01-26, earlier than ElectroSwap's ~April 2025 ceiling for that same token.
//    "First success wins" would have silently narrowed coverage for tokens like that. ElectroSwap is
//    still queried SECOND on every fresh backfill so its price wins ON CONFLICT for any day both
//    sources cover, keeping it the trusted/current source for the window it does cover — see
//    mergeBackfillResults and ensureBackfilled's own comment for the exact mechanics. There is no
//    exchange-listing fallback for arbitrary tokens the way there is for ETN — none of these tokens
//    trade anywhere but this chain's own DEX pools.
//  - ETN also falls back to ElectroSwap (via its WETN pool, merged with GeckoTerminal the same way
//    as any token) then to CoinGecko's historical-by-date endpoint (confirmed live: hard-capped at
//    the past 365 days on the free tier), only if KuCoin itself ever fails entirely — KuCoin's
//    unrestricted 2019-forward history is always tried first and stays primary for ETN; none of
//    these fallbacks can reach nearly as far back.
//
// TESTNET CAVEAT: GeckoTerminal is a mainnet indexer product — it will never index the testnet
// MockRouter/MockCoreToken pair used for the buy-and-burn lifecycle tests (see the PnL statement
// build plan's testnet-first section). PNL_PRICING_TESTNET_STUB_USD, if set, short-circuits every
// price lookup to a fixed value so the pricing plumbing itself (caching, FIFO cost-basis math) can
// still be exercised end-to-end on testnet without real market data.
import { fetchGeckoTerminal } from "../utils/tokenChartRouter.js";
import { resolveTokenPools } from "../utils/wetnPoolResolver.js";
import { getCandles, isElectroSwapConfigured } from "../utils/electroSwapApi.js";
import { getPricePoint, upsertPricePoint } from "../db/pricePoints.js";
import { getBackfillState, markBackfilled } from "../db/priceHistoryBackfillState.js";

const NETWORK = "electroneum";
// Same wrapped-Electroneum address tokenChartRouter.js prefers pools against — see that file's
// own comment for why WETN pricing (not raw USD-reserve ranking) is what this app treats as
// canonical, and why ETN's own historical price is derived from WETN pools (ETN/WETN are 1:1
// pegged; GeckoTerminal indexes the wrapped pools, not native ETN transfers).
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const NATIVE_SENTINEL = "NATIVE";
// Node's built-in fetch has no default request timeout — see pnlIngestion.js's own copy of this
// constant for the live failure this guards against (a stalled connection can hang a statement
// generation indefinitely with no error and near-zero CPU/memory). Every direct fetch() in this
// file passes this as its signal.
const FETCH_TIMEOUT_MS = process.env.PNL_FETCH_TIMEOUT_MS ? parseInt(process.env.PNL_FETCH_TIMEOUT_MS, 10) : 20000;

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

// Pool discovery/ranking itself (the GeckoTerminal API call) now lives in wetnPoolResolver.js,
// shared with dexPriceQuote.js's live spot pricing — see that file's own header comment for why
// this moved out of an in-memory-only cache (a redeploy used to make both files re-pay the same
// GeckoTerminal crawl independently). `bestPool` here matches this function's own original
// semantics exactly: prefer a WETN-paired pool, fall back to the highest-liquidity pool of ANY
// type — correct for this file's use, since the OHLCV endpoint fetchNearestCandleUsd/
// backfillPoolDailyHistory call converts to USD server-side regardless of which pool it is,
// unlike dexPriceQuote.js's own on-chain math, which specifically needs a WETN leg.
async function resolvePoolAddress(tokenAddress) {
  const { bestPool } = await resolveTokenPools(tokenAddress);
  return bestPool;
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

/** Bulk-backfills an asset's ElectroSwap-indexed daily price history in ONE call — up to the
 * candles endpoint's own 500-day-per-call ceiling (see electroSwapApi.js's getCandles for how that
 * ceiling was confirmed live: a cursor-less, at-the-cap request came back with cursor: null, and
 * per ElectroSwap's own OpenAPI spec cursor is "the cursor from a previous response" for paging
 * further back — a null cursor on the very FIRST page means nothing further back exists to page
 * to, not an untriggered pagination mechanism). Since this chain's EVM only went live ~March 2024,
 * that 500-day ceiling currently reaches most pools' entire real history in a single 600-credit
 * call. Queried AFTER backfillAssetPriceHistory (GeckoTerminal) in ensureBackfilled, not instead of
 * it — see that function's own comment and mergeBackfillResults for why "first success wins" was
 * reverted (GeckoTerminal can, for a pool it's indexed a long while, reach further back than
 * ElectroSwap's own ceiling — confirmed live for WETN). Deliberately returns null rather than
 * `{ earliestDate: null, poolCount: 0 }` on "nothing to backfill" so mergeBackfillResults' null
 * handling treats "ElectroSwap has nothing for this asset" exactly the same as "ElectroSwap isn't
 * configured" — one code path, not two. */
async function backfillTokenFromElectroSwap(cacheAsset, tokenAddress) {
  if (!isElectroSwapConfigured()) return null;
  const candles = await getCandles(tokenAddress, "1d", 500);
  if (!candles || candles.length === 0) return null;

  let earliestDate = null;
  for (const c of candles) {
    const day = new Date(c.time * 1000);
    day.setUTCHours(0, 0, 0, 0);
    await upsertPricePoint(cacheAsset, day, c.close, "electroswap-backfill");
    if (!earliestDate || day < earliestDate) earliestDate = day;
  }
  return { earliestDate, poolCount: 1 };
}

const KUCOIN_CANDLES_URL = "https://api.kucoin.com/api/v1/market/candles";
const KUCOIN_SYMBOL = "ETN-USDT"; // confirmed live listed, real daily data back to 2019-07-10
const KUCOIN_PAGE_SIZE = 1500; // KuCoin's own per-request cap for this endpoint, confirmed live
// Sanity floor for backfillEtnFromKucoin's result — comfortably after the pair's confirmed real
// listing date (2019-07-10) but early enough to never reject a genuine full backfill. Guards
// against exactly the failure mode observed live once already: a page fetch mid-pagination
// returning fewer than KUCOIN_PAGE_SIZE rows (a transient truncated/short response, not "reached
// real history") satisfies backfillEtnFromKucoin's own "no more history" loop-exit condition just
// as a genuine end-of-history page would, silently capping coverage — and since that's a normal
// (non-throwing) result, ensureBackfilled would otherwise record it as permanently done, never
// retrying. If the pagination stops later than this floor, ensureBackfilled treats it as
// incomplete instead of trusting it.
const KUCOIN_ETN_SANITY_FLOOR = new Date("2020-01-01T00:00:00.000Z");

/** Bulk-backfills native ETN's ENTIRE KuCoin trading history — paginated by narrowing `endAt`
 * backward past the oldest candle each page returns (confirmed live: KuCoin returns the most
 * recent candles within [startAt, endAt], not the oldest, so startAt stays fixed at 1 and endAt is
 * what walks backward), until a page comes back with fewer than KUCOIN_PAGE_SIZE candles — which
 * is genuinely "no more history", not a rolling-window cutoff like the indexer sources below. */
async function backfillEtnFromKucoin() {
  let endAtSec = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
  let earliestDate = null;
  let totalCandles = 0;
  // 12 pages * 1500 days ≈ 49 years — comfortably past any realistic listing date, purely a safety
  // ceiling against an unbounded loop, same reasoning as backfillPoolDailyHistory's own cap.
  for (let page = 0; page < 12; page++) {
    let json;
    try {
      const res = await fetch(`${KUCOIN_CANDLES_URL}?type=1day&symbol=${KUCOIN_SYMBOL}&startAt=1&endAt=${endAtSec}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      if (json.code !== "200000") throw new Error(`KuCoin error ${json.code}: ${json.msg || "unknown"}`);
    } catch (err) {
      console.warn(`⚠️  KuCoin ETN price backfill: page fetch failed:`, err.message);
      break;
    }
    const rows = json.data || [];
    if (rows.length === 0) break;

    let oldestSecThisPage = Infinity;
    for (const row of rows) {
      // KuCoin's own documented column order for this endpoint: [time, open, close, high, low,
      // volume, turnover] — close is index 2, NOT the usual OHLC index 3/4.
      const sec = Number(row[0]);
      const close = Number(row[2]);
      const day = new Date(sec * 1000);
      day.setUTCHours(0, 0, 0, 0);
      await upsertPricePoint("ETN", day, close, "kucoin");
      totalCandles++;
      if (!earliestDate || day < earliestDate) earliestDate = day;
      if (sec < oldestSecThisPage) oldestSecThisPage = sec;
    }
    if (rows.length < KUCOIN_PAGE_SIZE || oldestSecThisPage >= endAtSec) break;
    endAtSec = oldestSecThisPage - 1;
  }
  return { earliestDate, poolCount: totalCandles > 0 ? 1 : 0 };
}

// In-memory only, never persisted — an asset whose backfill attempt THREW (not just "found no
// data", which markBackfilled below already records permanently) gets skipped for the rest of
// this process's lifetime, not forever. Confirmed live: a token whose pool OHLCV endpoint returns
// a hard 401 from GeckoTerminal re-ran the ENTIRE bulk backfill sequence (a `pools` lookup and up
// to 20 OHLCV pages per candidate pool) on every single distinct date that token needed pricing at
// during one statement generation, since a thrown error never reached markBackfilled and so never
// left a price_history_backfill_state row for getBackfillState to short-circuit on next call — for
// a wallet with many transactions in that one token, this took a real, growing multiple of what it
// should have. Deliberately NOT persisted to the DB the way a genuine "no data" result is: a 401
// might be transient (an outage, a temporary API-tier issue) and a later process run — or even a
// later statement generation in the same deploy — should still get to retry it for real, rather
// than being permanently told "no price data exists" by a state row born from an exception.
const failedBackfillThisRun = new Set();

/** Combines two backfill results (see backfillAssetPriceHistory/backfillTokenFromElectroSwap,
 * either of which may be null or have a null earliestDate) into the widest range either alone
 * achieved: the earlier of the two earliestDates, and their pool/source counts summed for the
 * recorded log line. Null-safe in every direction — either or both inputs can be null. */
function mergeBackfillResults(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const earliestDate =
    a.earliestDate && b.earliestDate ? (a.earliestDate < b.earliestDate ? a.earliestDate : b.earliestDate) : a.earliestDate || b.earliestDate;
  return { earliestDate, poolCount: (a.poolCount || 0) + (b.poolCount || 0) };
}

/** Runs the appropriate bulk backfill exactly once, ever, per asset — recorded in
 * price_history_backfill_state. Every getHistoricalPriceUsd call routes through this first, so the
 * very first lookup for a brand-new asset triggers the bulk fetch (a handful of calls) and every
 * lookup after that — for that date or any other, in this statement or a future one — is a pure
 * price_points cache read. A failed backfill attempt (the bulk fetch itself throwing) is NOT
 * recorded as permanently done in the DB, so a future process run still retries it — but see
 * failedBackfillThisRun above for why it IS skipped for the rest of THIS run. */
async function ensureBackfilled(cacheAsset, tokenAddress) {
  const state = await getBackfillState(cacheAsset);
  if (state) return state;
  if (failedBackfillThisRun.has(cacheAsset)) return null;

  try {
    let result = cacheAsset === "ETN" ? await backfillEtnFromKucoin() : null;
    // KuCoin's own history is the only source that reaches back to 2019 — everything below it is a
    // fallback for when KuCoin comes back empty (ETN) or was never tried at all (every token), so
    // track whether KuCoin's result is actually what ends up recorded, separately from `result`
    // itself getting overwritten by a later fallback.
    const usedKucoin = Boolean(result && result.earliestDate);

    if (!usedKucoin) {
      // ALWAYS try both remaining sources and merge to the broadest combined range — deliberately
      // NOT "first success wins". Confirmed live this matters: this file's own top comment
      // describes GeckoTerminal's OHLCV as capped at "roughly the last 184 days regardless of pool
      // age", based on a one-time measurement — turns out that reflects a fixed historical floor
      // from whenever GeckoTerminal started indexing a given pool, not a rolling window relative to
      // "now", so the number of days it measures as grows over real time. Real production data
      // proved this: WETN's existing GeckoTerminal backfill (20 pools) had already reached
      // 2025-01-26, EARLIER than ElectroSwap's own ~500-day/since-pool-creation ceiling for that
      // same token (~April 2025) — so "ElectroSwap succeeded, skip GeckoTerminal entirely" would
      // have silently narrowed WETN's recorded coverage on its very next re-backfill. Querying both
      // once (this only ever runs once, ever, per asset — not a hot path) and keeping the earlier
      // of the two dates avoids ever regressing below what GeckoTerminal alone already achieved,
      // while still gaining ElectroSwap for tokens/pools it covers that GeckoTerminal doesn't (or
      // doesn't reach as cleanly). ElectroSwap is queried SECOND so its price wins ON CONFLICT for
      // any day both sources cover — same "later call wins the overlap" convention
      // backfillAssetPriceHistory's own pools loop already uses — keeping it the trusted/current
      // source for its own window while GeckoTerminal fills in anything older it doesn't reach.
      const geckoResult = await backfillAssetPriceHistory(cacheAsset, tokenAddress);
      const electroResult = await backfillTokenFromElectroSwap(cacheAsset, tokenAddress);
      result = mergeBackfillResults(geckoResult, electroResult);
    }

    // See KUCOIN_ETN_SANITY_FLOOR's comment: a mid-pagination KuCoin hiccup can produce a
    // non-throwing but truncated result that looks identical to a genuine "reached real history"
    // stop. Confirmed live once already (recorded earliest_available_date of 2025-02-24, when the
    // pair's real listing is 2019-07-10). Only applies when KuCoin's OWN result is what's being
    // recorded — a later fallback (ElectroSwap/GeckoTerminal) genuinely can't reach past
    // ~2024/~184-days-ago and shouldn't be judged against a floor that assumes KuCoin's much
    // deeper history. Don't let a suspiciously-recent ETN-via-KuCoin result get recorded as
    // permanently done — leave no state row so the next call retries the full bulk fetch.
    if (usedKucoin && result.earliestDate > KUCOIN_ETN_SANITY_FLOOR) {
      console.warn(
        `⚠️  ETN KuCoin backfill only reached ${result.earliestDate.toISOString().slice(0, 10)} (expected back to ~2019-07-10) — treating as incomplete, not recording as backfilled. Will retry next call.`
      );
      return null;
    }

    await markBackfilled(cacheAsset, { earliestAvailableDate: result.earliestDate, poolCount: result.poolCount });
    console.log(
      `💰 Price history backfilled for ${cacheAsset}: earliest available ${result.earliestDate ? result.earliestDate.toISOString().slice(0, 10) : "none found"}, ${result.poolCount} source(s) scanned`
    );
    // Constructed rather than re-fetched via getBackfillState — markBackfilled doesn't return the
    // row, and we already have everything it would contain right here.
    return { earliest_available_date: result.earliestDate, pool_count: result.poolCount };
  } catch (err) {
    console.warn(`⚠️  Price history backfill failed for ${cacheAsset}, falling back to per-date lookups:`, err.message);
    failedBackfillThisRun.add(cacheAsset);
    return null;
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

// In-memory only, never persisted — same "don't retry a proven-broken lookup for the rest of this
// run" reasoning as failedBackfillThisRun above, one level down: even with that Set short-
// circuiting ensureBackfilled's bulk retry, getHistoricalPriceUsd's own per-date LIVE fallback
// (resolvePoolAddress + fetchNearestCandleUsd, right below) still runs unconditionally on every
// call for a date price_points doesn't already have cached — and a token whose pool 401s
// permanently never gets a successful upsertPricePoint to short-circuit on. Confirmed live: the
// exact same (token, day) pair reappeared verbatim in the logs across multiple checks minutes
// apart during one statement generation, for a wallet with several genuinely different call sites
// (gas, cost basis, disposal valuation, etc.) all needing that one unresolvable day's price —
// each one repeating the identical failing live lookup. Keyed by "asset|isoDate", scoped to the
// process lifetime like failedBackfillThisRun, for the identical reason: a live fetch failure here
// might be transient and shouldn't become a permanent "no price data" claim for a future run.
const failedPriceLookupThisRun = new Set();

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
    `https://api.coingecko.com/api/v3/coins/electroneum/history?date=${dd}-${mm}-${yyyy}&localization=false`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
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

  // "collectionAddress:tokenId" — pnlStatementGenerator.js's NFT lot key convention (see
  // buildNftEvents). No fungible-market price feed exists for one specific NFT — fail fast rather
  // than wasting a bulk-backfill attempt (and a stray price_history_backfill_state row) on a
  // string that was never a real token address to begin with.
  if (asset.includes(":")) {
    throw new Error(`No price feed for individual NFT ${asset} — NFT valuation comes from correlated same-tx payments, not a market price`);
  }

  const isNative = asset === NATIVE_SENTINEL || asset.toUpperCase() === "ETN";
  const cacheAsset = isNative ? "ETN" : asset.toLowerCase();
  const bucketed = bucketToDay(timestamp);
  const tokenAddress = isNative ? WETN_ADDRESS : asset;

  const backfillState = await ensureBackfilled(cacheAsset, tokenAddress);

  const cached = await getPricePoint(cacheAsset, bucketed);
  if (cached) return Number(cached.price_usd);

  // The bulk backfill already walked this asset's ENTIRE available on-chain history (or ETN's full
  // KuCoin history) and recorded exactly how far back real data goes — see backfillPoolDailyHistory
  // and this file's own top comment on GeckoTerminal's ~184-day OHLCV ceiling (a hard account-tier
  // restriction, not a per-request quirk: the bulk pass can't reach further back regardless of how
  // many pages it requests, and neither can a live per-date lookup against the same source). A date
  // older than that recorded ceiling — or a backfill that found no data at all — can never resolve
  // here; fail fast instead of repeating the same doomed live GeckoTerminal/CoinGecko call for every
  // individual day beyond it. Confirmed live: without this, backfillPnlHistory's up-to-365-day scan
  // tripped GeckoTerminal's rate limit hammering this exact live fallback once per (token, old day).
  if (backfillState && (!backfillState.earliest_available_date || bucketed < new Date(backfillState.earliest_available_date))) {
    throw new Error(
      `No price data available for ${cacheAsset} before ${
        backfillState.earliest_available_date ? new Date(backfillState.earliest_available_date).toISOString().slice(0, 10) : "any date"
      } (known bulk-backfill ceiling) — requested ${bucketed.toISOString().slice(0, 10)}`
    );
  }

  const failKey = `${cacheAsset}|${bucketed.toISOString()}`;
  if (failedPriceLookupThisRun.has(failKey)) {
    throw new Error(`Could not resolve historical USD price for ${cacheAsset} at ${bucketed.toISOString()} (cached failure this run)`);
  }

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
    failedPriceLookupThisRun.add(failKey);
    throw new Error(`Could not resolve historical USD price for ${cacheAsset} at ${bucketed.toISOString()}`);
  }

  await upsertPricePoint(cacheAsset, bucketed, priceUsd, source);
  return priceUsd;
}

/**
 * Cache-only variant of getHistoricalPriceUsd — checks price_points and returns immediately,
 * NEVER calls ensureBackfilled (the expensive part: a brand-new asset's full bulk OHLCV history,
 * up to 20 GeckoTerminal pages, rate-limited through the shared queue) and never falls back to a
 * live external lookup either. Returns null (never throws) for an asset/date this backend hasn't
 * already priced for some OTHER reason — same "omit rather than fake" convention as the rest of
 * this app's pricing code, just with "haven't bothered to check yet" as an additional legitimate
 * reason for null, on top of "checked and couldn't resolve".
 *
 * Built for pnlIngestion.js's priorityAssets scoping (see that file's own header comment on the
 * ongoing-dashboard-PnL cold-start speedup this exists for): a non-priority token still gets
 * priced for free if it happens to already be cached (common — many tokens are shared across
 * users' wallets and get backfilled once, globally, the first time ANY wallet touches them), and
 * only genuinely never-seen-before tokens get deferred.
 */
export async function getCachedHistoricalPriceUsd(asset, timestamp) {
  if (asset.includes(":")) return null; // an NFT lot key, never priced this way at all — see getHistoricalPriceUsd's own guard

  const isNative = asset === NATIVE_SENTINEL || asset.toUpperCase() === "ETN";
  const cacheAsset = isNative ? "ETN" : asset.toLowerCase();
  const bucketed = bucketToDay(timestamp);

  const cached = await getPricePoint(cacheAsset, bucketed);
  return cached ? Number(cached.price_usd) : null;
}
