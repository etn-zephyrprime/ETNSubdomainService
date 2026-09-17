// backend/utils/tokenChartRouter.js
//
// Backs the dashboard's Tokens tab — per-token price chart data, on click. Every other dashboard
// data source (Blockscout, CoinGecko's regular API) is called directly from the browser because
// both are confirmed CORS-open with no practical rate limit under normal use. GeckoTerminal's
// free "onchain" API is the one exception: confirmed live that it 429s after roughly half a
// dozen requests in quick succession, with no way for a single visitor's browser to know or
// coordinate with any other visitor's. A shared, cached backend proxy is what makes "click any
// token, see its chart" safe under real traffic instead of a source of frequent rate-limit
// errors — this is the one dashboard feature that needed backend involvement at all.
//
// Confirmed live before building this: GeckoTerminal indexes ElectroSwap's pools directly on its
// "electroneum" network (real pools: CORE/WETN, USDT/WETN, USDC/WETN, etc.) — this is genuinely
// on-chain ElectroSwap data, just reached through GeckoTerminal's existing indexer rather than
// this backend re-implementing pool-reserve/Swap-event scanning from scratch.
import express from "express";
import { ethers } from "ethers";
import { getPricePointsSince } from "../db/pricePoints.js";
import { getCandles as getElectroSwapCandles, getBatchTokenPrices } from "./electroSwapApi.js";

const GECKOTERMINAL_API_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "electroneum";
// Wrapped Electroneum — ElectroSwap's de facto quote asset. Confirmed live (e.g. BOLT) that
// picking pools by raw USD reserve alone can pass over a real, meaningfully liquid WETN pair in
// favor of a slightly-higher-reserve pool quoted in some other token (DYNO/BOLT out-reserved
// BOLT/WETN by ~2.5x despite both being real, active pools) — WETN pricing is what this
// dashboard's users actually want to see, so it's preferred whenever a WETN pair exists at all,
// not just used as an if-nothing-else-exists fallback.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

// Node's built-in fetch has no default request timeout — confirmed live this let a PnL statement
// generation (a caller of fetchGeckoTerminal below, via pnlPricing.js) hang indefinitely on a
// stalled connection, with no error and near-zero CPU/memory the whole time. 20s is generous for
// this endpoint's small JSON responses under normal conditions.
const FETCH_TIMEOUT_MS = process.env.PNL_FETCH_TIMEOUT_MS ? parseInt(process.env.PNL_FETCH_TIMEOUT_MS, 10) : 20000;

// How long a token's chart response is reused before re-fetching from GeckoTerminal — the whole
// point of this cache is cutting down *repeat* views of the same token, not just the first one,
// since that's the case a shared rate limit actually gets exhausted by.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // `${address}:${range}` -> { expiresAt, payload }

// Separate, longer-lived cache for the *pool lookup* specifically — confirmed live this was a
// real gap: the 7D/30D/90D pills this UI ships re-run the exact same pool lookup for every range
// click on the same token (which pool has the deepest liquidity doesn't depend on the range being
// viewed), so it was tripling GeckoTerminal calls for the single most obvious user action on this
// page. Keyed by address alone, not address:range.
const POOL_CACHE_TTL_MS = 15 * 60 * 1000;
const poolCache = new Map(); // address -> { expiresAt, pools }

// Backs /token-prices — a portfolio view (CoreTierPortfolio.jsx/CoreTierDemo.jsx/
// AddressLookup.jsx) pricing up to 50 distinct holdings at once used to fire 50 individual
// /token-chart requests (each one a full pool-discovery + OHLCV-candle fetch, just to read the
// single latest close) through this file's own rate-limited GeckoTerminal queue — confirmed live
// a single cold /token-chart call can itself take 90+ seconds when ElectroSwap's own candles
// endpoint is slow to respond and retries before falling back, so 50 of them fired in parallel
// could never realistically finish inside a normal page view, leaving a portfolio's "Tokens" slice
// looking like $0 regardless of real holdings. This endpoint prices a whole batch in two calls
// total instead of up to 50: ElectroSwap's own batched /prices endpoint first (already used
// elsewhere in this backend, e.g. tokenPriceCache.js — cheap, one round trip for up to 50
// addresses), then GeckoTerminal's "simple" token_price endpoint (confirmed live: a real current
// price, no pool discovery or candle history needed) for whatever ElectroSwap didn't have a price
// for. Cached per-address (not per-request address list) so two overlapping portfolios' requests
// still share cache hits.
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map(); // address (lowercase) -> { expiresAt, price }
// GeckoTerminal's own documented cap for this endpoint — separate from ElectroSwap's own
// MAX_BATCH_ADDRESSES (50) above since it's a different API with its own limit.
const GECKOTERMINAL_PRICE_BATCH_SIZE = 30;

/** GeckoTerminal's lightweight current-price endpoint — a real spot price straight from its own
 * indexed pools, no pool-selection or OHLCV-candle fetch needed (unlike loadTokenChart below,
 * which exists to serve a full chart, not just today's number). Routed through the same
 * fetchGeckoTerminal queue as every other GeckoTerminal call in this file, so it shares the same
 * rate-limit protection rather than opening a second, uncoordinated path to the same budget.
 * Returns a Map (address -> price); an address GeckoTerminal has no price for is simply absent,
 * not an error — same "missing means unpriced, not failed" contract as getBatchTokenPrices. */
async function getBatchGeckoTerminalPrices(addresses) {
  const prices = new Map();
  for (let i = 0; i < addresses.length; i += GECKOTERMINAL_PRICE_BATCH_SIZE) {
    const chunk = addresses.slice(i, i + GECKOTERMINAL_PRICE_BATCH_SIZE);
    try {
      const res = await fetchGeckoTerminal(`/simple/networks/${NETWORK}/token_price/${chunk.join(",")}`);
      const tokenPrices = res?.data?.attributes?.token_prices || {};
      for (const [address, price] of Object.entries(tokenPrices)) {
        const parsed = Number(price);
        if (Number.isFinite(parsed)) prices.set(address.toLowerCase(), parsed);
      }
    } catch (err) {
      console.warn(`⚠️  GeckoTerminal batch price lookup failed for ${chunk.length} token(s):`, err.message);
      // Continue to the next chunk — a transient failure for one chunk of up to 30 shouldn't
      // also cost the OTHER chunks their prices, same resilience as ElectroSwap's own batch call.
    }
  }
  return prices;
}

// All outbound GeckoTerminal calls are serialized through this queue with an enforced minimum
// gap between them — confirmed live that a burst of requests without any spacing (e.g. a user
// clicking through several tokens, or several visitors doing so at once) trips the rate limit
// even with the caches above, since a cache only helps on a *repeat* request. This is a token
// bucket, not just an anti-simultaneity guard: confirmed live that ~5-6 calls succeed instantly
// (the initial burst allowance) but calls immediately after that need real spacing to succeed —
// a short interval (400ms) only prevented literally-simultaneous calls and still 429'd on a
// handful of genuinely new (uncached) tokens browsed back to back right after that initial
// burst. 1.5s keeps sustained browsing (new token every few seconds, the realistic case once the
// obvious first burst is used up) under whatever GeckoTerminal's refill rate actually is, at the
// cost of a slightly slower first-ever load for a given token — acceptable since the UI already
// shows "Loading…" and every subsequent view of that same token is a cache hit (0 extra calls).
const MIN_GT_INTERVAL_MS = 1500;
// Once any call gets a 429, every other call already queued behind it — and every retry —
// waits out this shared cooldown together, instead of each one independently retrying on its
// own timer. Without this, a burst that trips the limit turned into a *worse* burst a few
// seconds later (every failed request retrying at once), rather than the queue actually easing
// off.
const RATE_LIMIT_COOLDOWN_MS = 8000;
let gtQueueTail = Promise.resolve();
let gtLastCallAt = 0;
let gtCooldownUntil = 0;

function enqueueGeckoTerminalCall(fn) {
  const run = gtQueueTail.then(async () => {
    const wait = Math.max(0, gtLastCallAt + MIN_GT_INTERVAL_MS - Date.now(), gtCooldownUntil - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    gtLastCallAt = Date.now();
    return fn();
  });
  // Keep the queue chain alive even after a rejection — otherwise one failed call would
  // permanently break every call queued after it.
  gtQueueTail = run.catch(() => {});
  return run;
}

// `limit` here is deliberately generous (GeckoTerminal's own cap is 1000) rather than "just
// enough candles for the range" — confirmed live that GeckoTerminal OMITS candle periods with
// zero trades entirely instead of returning a flat/carried-forward candle for them. For a
// thinly-traded pool, "last 42 4-hour candles" can silently reach back 17+ days instead of 7,
// which would mislabel the chart. Fetching generously and then filtering by real elapsed time
// (see `windowMs` below) is what keeps the "7D"/"30D"/"90D" pills honest regardless of how
// active a given pool is.
// electroSwapBucket: the equivalent bucket size on ElectroSwap's own candles endpoint (see
// tryElectroSwapCandles below) — '4h' for the 7-day view, '1d' for 30/90, matching the same
// granularity GeckoTerminal's timeframe/aggregate pair already produces for each range.
const RANGE_PARAMS = {
  "7": { timeframe: "hour", aggregate: 4, limit: 1000, windowMs: 7 * 24 * 60 * 60 * 1000, electroSwapBucket: "4h" },
  "30": { timeframe: "day", aggregate: 1, limit: 1000, windowMs: 30 * 24 * 60 * 60 * 1000, electroSwapBucket: "1d" },
  "90": { timeframe: "day", aggregate: 1, limit: 1000, windowMs: 90 * 24 * 60 * 60 * 1000, electroSwapBucket: "1d" },
};
// Generous like GeckoTerminal's own `limit` above (fetch more than the window strictly needs, then
// filter by real elapsed time) — comfortably covers 90 daily candles or 7 days of 4-hour candles
// (42) with room to spare, well under ElectroSwap's own 500-item batch cap.
const ELECTROSWAP_CANDLE_LIMIT = 200;

/** Tries ElectroSwap's own candles endpoint for this token/range — a direct token-address lookup,
 * no per-pool selection needed (unlike the GeckoTerminal path below, which has to pick a specific
 * pool first). Returns null (not an error) if unconfigured, ElectroSwap has no data for this
 * token, or the call fails — the caller falls back to the existing GeckoTerminal OHLCV fetch in
 * every such case, so this never changes the "does a chart exist for this token" contract
 * (hasData/pool are computed from GeckoTerminal's own pool discovery either way — see
 * loadTokenChart below). */
async function tryElectroSwapCandles(address, range, windowMs) {
  const { electroSwapBucket } = RANGE_PARAMS[range] || RANGE_PARAMS["30"];
  const raw = await getElectroSwapCandles(address, electroSwapBucket, ELECTROSWAP_CANDLE_LIMIT);
  if (!raw || raw.length === 0) return null;

  const cutoffMs = Date.now() - windowMs;
  const candles = raw
    .map((c) => ({
      label: new Date(c.time * 1000).toISOString(),
      timeMs: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volumeUsd: c.volume,
    }))
    .filter((c) => c.timeMs >= cutoffMs)
    .sort((a, b) => a.timeMs - b.timeMs); // never trust the source's own ordering
  return candles.length > 0 ? candles : null;
}

// Exported so other backend callers hitting GeckoTerminal (currently: pnlPricing.js, resolving
// historical trade prices for PnL statements) share this exact queue/cooldown instead of running
// a second independent rate limiter against the same shared GeckoTerminal budget — two queues
// that each individually respect the limit can still trip it together if they don't know about
// each other.
export async function fetchGeckoTerminal(path, { retryOn429 = true } = {}) {
  const doFetch = () => enqueueGeckoTerminalCall(async () => {
    const res = await fetch(`${GECKOTERMINAL_API_BASE}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 429) {
      gtCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      const err = new Error("GeckoTerminal rate limit hit");
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`GeckoTerminal ${path} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });

  try {
    return await doFetch();
  } catch (err) {
    if (err.rateLimited && retryOn429) {
      // One bounded retry — by the time this re-enters the queue, gtCooldownUntil (just set
      // above) makes it wait out the shared cooldown rather than hitting GeckoTerminal again
      // immediately.
      return fetchGeckoTerminal(path, { retryOn429: false });
    }
    throw err;
  }
}

async function getPools(address) {
  const key = address.toLowerCase();
  const cached = poolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.pools;

  // A 404 here means GeckoTerminal has never indexed this token at all (confirmed live — most
  // of the long-tail/spam tokens on this chain hit this, not an empty-but-valid response), which
  // means exactly the same thing to a caller as a 200 with zero pools: no chart to show. Cache
  // that outcome too, same TTL — a known-dead token shouldn't cost a fresh lookup every range
  // click either.
  let pools;
  try {
    const poolsRes = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${address}/pools`);
    pools = poolsRes.data || [];
  } catch (err) {
    if (err.status === 404) {
      pools = [];
    } else {
      throw err;
    }
  }
  poolCache.set(key, { pools, expiresAt: Date.now() + POOL_CACHE_TTL_MS });
  return pools;
}

function highestReserve(pools) {
  return pools.reduce((a, b) =>
    Number(b.attributes.reserve_in_usd || 0) > Number(a.attributes.reserve_in_usd || 0) ? b : a
  );
}

async function loadTokenChart(address, range) {
  const pools = await getPools(address);
  if (pools.length === 0) {
    return { hasData: false };
  }

  // Prefer the highest-liquidity WETN pair if one exists at all — see WETN_ADDRESS's comment —
  // and only fall back to highest-liquidity-regardless-of-pair when this token has no WETN pool.
  // A thin/dead pool with $2 of reserves shouldn't win either selection just for lacking
  // competition.
  const tokenId = `${NETWORK}_${address.toLowerCase()}`;
  const wetnId = `${NETWORK}_${WETN_ADDRESS}`;
  const wetnPools = pools.filter((p) => {
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const otherId = baseId === tokenId ? quoteId : baseId;
    return otherId === wetnId;
  });
  const best = highestReserve(wetnPools.length > 0 ? wetnPools : pools);
  const poolAddress = best.attributes.address;
  const isBase = best.relationships?.base_token?.data?.id === `${NETWORK}_${address.toLowerCase()}`;
  const tokenSide = isBase ? "base" : "quote";

  const { timeframe, aggregate, limit, windowMs } = RANGE_PARAMS[range] || RANGE_PARAMS["30"];
  const pool = { name: best.attributes.name, reserveUsd: Number(best.attributes.reserve_in_usd || 0) };

  // ElectroSwap's own candles first — a direct token-address lookup (no pool-address plumbing
  // needed), official first-party data, and it doesn't compete with GeckoTerminal's shared rate
  // limit at all. `pool`/hasData above are unaffected either way — they're still GeckoTerminal-
  // pool-discovery-based (see this function's own top half), so a token whose real pool ElectroSwap
  // just doesn't have candle data for yet still correctly reports "has a real pool" rather than
  // looking confirmed-dead.
  let candles = await tryElectroSwapCandles(address, range, windowMs);
  if (!candles) {
    const ohlcvRes = await fetchGeckoTerminal(
      `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${tokenSide}`
    );
    const list = ohlcvRes.data?.attributes?.ohlcv_list || [];
    const cutoffMs = Date.now() - windowMs;
    // GeckoTerminal returns newest-first; this app's charts all expect oldest-first. The windowMs
    // filter is what actually makes "7D" mean the last 7 days — see the RANGE_PARAMS comment above.
    candles = [...list]
      .reverse()
      .map(([sec, open, high, low, close, volumeUsd]) => ({
        label: new Date(sec * 1000).toISOString(),
        timeMs: sec * 1000,
        open,
        high,
        low,
        close,
        volumeUsd,
      }))
      .filter((c) => c.timeMs >= cutoffMs);
  }

  if (candles.length < 2) {
    // A real pool exists, it just hasn't traded within this specific window — distinct from
    // "no pool at all" so the frontend can point the user at a longer range instead of implying
    // this token has no market.
    return { hasData: false, reason: "no_recent_activity", pool };
  }

  return { hasData: true, candles, pool };
}

// Long-range ETN price history, backed by price_points (see pnlPricing.js's KuCoin backfill) —
// the Overview tab's short-range (7D/30D/90D) chart stays on live CoinGecko OHLC (EtnPriceChart.jsx
// via useCoinGecko.js), since CoinGecko's free 365-day cap comfortably covers those and gives real
// open/high/low/volume that price_points doesn't have (it's daily close only). This endpoint is
// for ranges CoinGecko's free tier can't serve at all — "1y" and "all" (back to KuCoin's real
// 2019-07-10 ETN-USDT listing once fully backfilled) — rendered as a line chart, not candles.
const ETN_PRICE_HISTORY_RANGES = {
  "1y": () => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
  all: () => new Date("2019-01-01T00:00:00.000Z"), // safely before KuCoin's confirmed 2019-07-10 listing
};
const ETN_PRICE_HISTORY_CACHE_TTL_MS = 60 * 60 * 1000; // price_points updates at most once/day (daily candles) — no need to re-hit the DB more often than this
const etnPriceHistoryCache = new Map(); // range -> { expiresAt, payload }

const router = express.Router();

router.get("/etn-price-history", async (req, res) => {
  const range = String(req.query.range || "1y");
  const sinceFn = ETN_PRICE_HISTORY_RANGES[range];
  if (!sinceFn) {
    return res.status(400).json({ error: "Invalid range — use 1y or all" });
  }

  const cached = etnPriceHistoryCache.get(range);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.payload);
  }

  try {
    const rows = await getPricePointsSince("ETN", sinceFn());
    const payload = {
      points: rows.map((r) => ({ timestamp: r.timestamp, priceUsd: Number(r.price_usd) })),
    };
    etnPriceHistoryCache.set(range, { payload, expiresAt: Date.now() + ETN_PRICE_HISTORY_CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    console.error("⚠️  ETN price history failed:", err.message);
    res.status(502).json({ error: "Couldn't load ETN price history" });
  }
});

router.get("/token-chart", async (req, res) => {
  const address = String(req.query.address || "");
  const range = String(req.query.range || "30");

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  if (!RANGE_PARAMS[range]) {
    return res.status(400).json({ error: "Invalid range — use 7, 30, or 90" });
  }

  const cacheKey = `${address.toLowerCase()}:${range}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.payload);
  }

  try {
    const payload = await loadTokenChart(address, range);
    cache.set(cacheKey, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    if (err.rateLimited) {
      console.warn(`⚠️  Token chart: GeckoTerminal rate limit hit for ${address}`);
      return res.status(503).json({ error: "Chart data is temporarily unavailable — try again shortly" });
    }
    console.error(`⚠️  Token chart failed for ${address}:`, err.message);
    res.status(502).json({ error: "Couldn't load chart data" });
  }
});

/** Batch current-price lookup — see priceCache's own comment above for why this exists (a whole
 * portfolio's worth of holdings priced in two calls total, instead of up to 50 individual
 * /token-chart requests). ElectroSwap first, GeckoTerminal's lightweight simple-price endpoint for
 * whatever ElectroSwap didn't have. Returns a plain `{ [lowercased address]: usdPrice }` object —
 * an address neither source has a price for is simply absent, not an error, same "missing means
 * unpriced, not failed" contract as getBatchTokenPrices/getBatchGeckoTerminalPrices themselves.
 * Exported so callers other than this file's own /token-prices route can share the exact same
 * pricing logic/cache — e.g. computeDemoData() in coreTierDemoRouter.js, pricing the demo's
 * holdings ONCE at snapshot-generation time rather than needing any live per-visitor pricing call. */
export async function getBatchPricesUsd(addresses) {
  const now = Date.now();
  const prices = {};
  const missing = [];
  for (const addr of addresses) {
    const cached = priceCache.get(addr);
    if (cached && cached.expiresAt > now) {
      if (cached.price != null) prices[addr] = cached.price;
    } else {
      missing.push(addr);
    }
  }

  if (missing.length > 0) {
    try {
      // ElectroSwap first — one batched call, no per-token overhead (see this file's header
      // comment / electroSwapApi.js's own for why this is preferred over GeckoTerminal at all).
      const electroSwapPrices = await getBatchTokenPrices(missing);
      const stillMissing = [];
      for (const addr of missing) {
        const entry = electroSwapPrices.get(addr);
        if (entry?.usd != null) {
          prices[addr] = entry.usd;
          priceCache.set(addr, { price: entry.usd, expiresAt: now + PRICE_CACHE_TTL_MS });
        } else {
          stillMissing.push(addr);
        }
      }

      // GeckoTerminal for whatever ElectroSwap didn't have (a token it doesn't index at all, or
      // ELECTROSWAP_API_KEY isn't configured in this environment).
      if (stillMissing.length > 0) {
        const gtPrices = await getBatchGeckoTerminalPrices(stillMissing);
        for (const addr of stillMissing) {
          const price = gtPrices.get(addr);
          if (price != null) {
            prices[addr] = price;
            priceCache.set(addr, { price, expiresAt: now + PRICE_CACHE_TTL_MS });
          } else {
            // Neither source has a price — cache the miss too (same TTL) so a portfolio holding
            // genuinely unpriced/spam tokens doesn't re-attempt both APIs for them on every
            // request within the cache window, same reasoning getPools's own comment gives.
            priceCache.set(addr, { price: null, expiresAt: now + PRICE_CACHE_TTL_MS });
          }
        }
      }
    } catch (err) {
      // Whatever's already in `prices` (cache hits, plus any result that landed before this
      // failed) is still returned — a partial batch is more useful to a caller than a hard
      // failure that blanks out every holding's price.
      console.error("⚠️  Batch token price lookup failed:", err.message);
    }
  }

  return prices;
}

// See getBatchPricesUsd's own comment — this route is now a thin HTTP wrapper around it.
router.get("/token-prices", async (req, res) => {
  const raw = String(req.query.addresses || "");
  const addresses = [...new Set(raw.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean))];

  if (addresses.length === 0) {
    return res.status(400).json({ error: "Provide at least one address via ?addresses=a,b,c" });
  }
  if (addresses.some((a) => !ethers.isAddress(a))) {
    return res.status(400).json({ error: "One or more addresses is invalid" });
  }
  // Generous relative to every real caller's own MAX_PRICED_HOLDINGS cap (50) — just a sanity
  // ceiling against a malformed/abusive request, not a limit anyone legitimate should ever hit.
  if (addresses.length > 100) {
    return res.status(400).json({ error: "Too many addresses — 100 max per request" });
  }

  const prices = await getBatchPricesUsd(addresses);
  res.json({ prices });
});

export default router;
