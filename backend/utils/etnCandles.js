// backend/utils/etnCandles.js
//
// Fine-grained ETN/USD candles for Argus's 7D and 90D price charts, from KuCoin's ETN-USDT market —
// the same exchange pnlPricing.js already uses for ETN's long-range daily history.
//
// Why not CoinGecko (which the 7D/30D/90D charts used): on its free tier CoinGecko's /ohlc picks the
// candle size from the range and it can't be changed — 4 hours for 7 and 30 days (6 a day), and
// 4 DAYS beyond that (90 days = 23 candles), and it has no 5-minute OHLC at all. KuCoin's public
// candle endpoint serves any interval, so 7D can be 5-minute and 90D 12-hour.
//
// KuCoin omits an interval in which nothing traded (ETN-USDT is fairly quiet), so a raw response has
// holes. normalizeCandles fills each one with a flat candle at the previous close (zero volume) so the
// series really is one point per interval, evenly spaced — the charts position points by index, and an
// uneven series would silently compress quiet periods.
const KUCOIN_CANDLES_URL = "https://api.kucoin.com/api/v1/market/candles";
const KUCOIN_SYMBOL = "ETN-USDT";
const KUCOIN_PAGE_SIZE = 1500; // KuCoin's per-request cap for this endpoint
const FETCH_TIMEOUT_MS = 15000;
const MAX_WINDOWS = 12; // hard stop on paging (7D at 5 min needs 2)

// range id -> KuCoin interval. `ttlMs`: how long a response is reused before asking KuCoin again.
export const ETN_CANDLE_RANGES = {
  "7": { type: "5min", stepSec: 300, days: 7, ttlMs: 60 * 1000 },
  "90": { type: "12hour", stepSec: 12 * 60 * 60, days: 90, ttlMs: 30 * 60 * 1000 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** KuCoin rows are [time(sec), open, close, high, low, volume, turnover] — note close is index 2, not
 * the usual OHLC order (same quirk pnlPricing.js's own KuCoin code documents). Returns
 * [{ time (sec), open, high, low, close, volume }], unsorted, skipping malformed rows. */
function parseRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const time = Number(r?.[0]);
    const open = Number(r?.[1]);
    const close = Number(r?.[2]);
    const high = Number(r?.[3]);
    const low = Number(r?.[4]);
    const volume = Number(r?.[5]);
    if (![time, open, close, high, low].every(Number.isFinite) || open <= 0 || close <= 0) continue;
    out.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return out;
}

/** Sorted, de-duplicated, gap-filled candles covering [startSec, endSec] on a `stepSec` grid, times in
 * milliseconds. Empty intervals become flat candles at the previous close with zero volume, including
 * up to the current interval so the right edge is "now" even after a quiet spell. Exported for tests. */
export function normalizeCandles(rows, stepSec, startSec, endSec) {
  const byTime = new Map();
  for (const c of parseRows(rows)) {
    if (c.time < startSec || c.time > endSec) continue;
    byTime.set(c.time, c); // a duplicate across page boundaries keeps the later one seen
  }
  if (byTime.size === 0) return [];

  const times = [...byTime.keys()].sort((a, b) => a - b);
  const lastBucket = Math.max(times[times.length - 1], Math.floor(endSec / stepSec) * stepSec);
  const out = [];
  let prev = null;
  for (let t = times[0]; t <= lastBucket; t += stepSec) {
    const real = byTime.get(t);
    if (real) {
      out.push({ time: t * 1000, open: real.open, high: real.high, low: real.low, close: real.close, volume: real.volume });
      prev = real;
    } else if (prev) {
      out.push({ time: t * 1000, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
      prev = { ...prev, close: prev.close };
    }
  }
  return out;
}

async function fetchWindow(type, startSec, endSec, fetchImpl) {
  const url = `${KUCOIN_CANDLES_URL}?type=${type}&symbol=${KUCOIN_SYMBOL}&startAt=${startSec}&endAt=${endSec}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
      const json = await res.json();
      if (json?.code !== "200000") throw new Error(`KuCoin error ${json?.code}: ${json?.msg || "unknown"}`);
      return json.data || [];
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(500);
    }
  }
  throw lastErr;
}

/** Fetches `days` of `type` candles ending now. Pages by TIME WINDOW (each window is one KuCoin page's
 * worth of intervals) rather than by "did this page come back full", because KuCoin omits empty
 * intervals — a quiet stretch returns a short page that says nothing about having reached the start. */
export async function fetchEtnCandles(rangeId, { nowSec = Math.floor(Date.now() / 1000), fetchImpl = fetch } = {}) {
  const cfg = ETN_CANDLE_RANGES[rangeId];
  if (!cfg) throw new Error(`Unknown ETN candle range: ${rangeId}`);

  const startSec = nowSec - cfg.days * 86400;
  const windowSec = KUCOIN_PAGE_SIZE * cfg.stepSec;
  const rows = [];
  let winEnd = nowSec;
  for (let i = 0; i < MAX_WINDOWS && winEnd > startSec; i++) {
    const winStart = Math.max(startSec, winEnd - windowSec + 1);
    rows.push(...(await fetchWindow(cfg.type, winStart, winEnd, fetchImpl)));
    winEnd = winStart - 1;
  }
  return normalizeCandles(rows, cfg.stepSec, startSec, nowSec);
}
