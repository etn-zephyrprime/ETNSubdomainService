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

const GECKOTERMINAL_API_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "electroneum";
// Wrapped Electroneum — ElectroSwap's de facto quote asset. Confirmed live (e.g. BOLT) that
// picking pools by raw USD reserve alone can pass over a real, meaningfully liquid WETN pair in
// favor of a slightly-higher-reserve pool quoted in some other token (DYNO/BOLT out-reserved
// BOLT/WETN by ~2.5x despite both being real, active pools) — WETN pricing is what this
// dashboard's users actually want to see, so it's preferred whenever a WETN pair exists at all,
// not just used as an if-nothing-else-exists fallback.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

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
const RANGE_PARAMS = {
  "7": { timeframe: "hour", aggregate: 4, limit: 1000, windowMs: 7 * 24 * 60 * 60 * 1000 },
  "30": { timeframe: "day", aggregate: 1, limit: 1000, windowMs: 30 * 24 * 60 * 60 * 1000 },
  "90": { timeframe: "day", aggregate: 1, limit: 1000, windowMs: 90 * 24 * 60 * 60 * 1000 },
};

async function fetchGeckoTerminal(path, { retryOn429 = true } = {}) {
  const doFetch = () => enqueueGeckoTerminalCall(async () => {
    const res = await fetch(`${GECKOTERMINAL_API_BASE}${path}`);
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
  const ohlcvRes = await fetchGeckoTerminal(
    `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${tokenSide}`
  );
  const list = ohlcvRes.data?.attributes?.ohlcv_list || [];
  const cutoffMs = Date.now() - windowMs;
  // GeckoTerminal returns newest-first; this app's charts all expect oldest-first. The windowMs
  // filter is what actually makes "7D" mean the last 7 days — see the RANGE_PARAMS comment above.
  const candles = [...list]
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

  const pool = { name: best.attributes.name, reserveUsd: Number(best.attributes.reserve_in_usd || 0) };

  if (candles.length < 2) {
    // A real pool exists, it just hasn't traded within this specific window — distinct from
    // "no pool at all" so the frontend can point the user at a longer range instead of implying
    // this token has no market.
    return { hasData: false, reason: "no_recent_activity", pool };
  }

  return { hasData: true, candles, pool };
}

const router = express.Router();

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

export default router;
