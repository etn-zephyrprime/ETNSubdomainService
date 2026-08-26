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

// How long a token's chart response is reused before re-fetching from GeckoTerminal — the whole
// point of this cache is cutting down *repeat* views of the same token, not just the first one,
// since that's the case a shared rate limit actually gets exhausted by.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // `${address}:${range}` -> { expiresAt, payload }

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

async function fetchGeckoTerminal(path) {
  const res = await fetch(`${GECKOTERMINAL_API_BASE}${path}`);
  if (res.status === 429) {
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
}

async function loadTokenChart(address, range) {
  // A 404 here means GeckoTerminal has never indexed this token at all (confirmed live — most
  // of the long-tail/spam tokens on this chain hit this, not an empty-but-valid response), which
  // means exactly the same thing to a caller as a 200 with zero pools: no chart to show.
  let poolsRes;
  try {
    poolsRes = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${address}/pools`);
  } catch (err) {
    if (err.status === 404) return { hasData: false };
    throw err;
  }
  const pools = poolsRes.data || [];
  if (pools.length === 0) {
    return { hasData: false };
  }

  // Highest-liquidity pool is the most representative price for this token — a thin/dead pool
  // with $2 of reserves would otherwise be just as likely to get picked as a real, actively
  // traded one.
  const best = pools.reduce((a, b) =>
    Number(b.attributes.reserve_in_usd || 0) > Number(a.attributes.reserve_in_usd || 0) ? b : a
  );
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
