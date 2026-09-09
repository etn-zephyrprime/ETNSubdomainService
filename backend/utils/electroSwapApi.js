// backend/utils/electroSwapApi.js
//
// ElectroSwap's official public API (electroneum mainnet DEX) — metered by credits, no free tier.
// See the "electroswap-api" memory / https://electroswap.io/docs/api/ for the full reference; this
// file only wraps what this app actually needs so far: token pricing (batched USD/ETN) and OHLCV
// candles for chart data.
//
// Confirmed LIVE against the real API with a funded key — worth noting because their own docs and
// their own OpenAPI spec disagreed with each other on the batch endpoint's shape (the prose docs
// said it takes an `addresses` param; the spec showed only limit/cursor with an untyped response
// body). The real, confirmed behavior:
//   GET /prices/{chainId}/{address}         -> { data: { address, usd, etn } }
//   GET /prices/{chainId}?addresses=a,b,c   -> { data: { "<addr, lowercased>": { usd, etn }, ... } }
// `usd`/`etn` are decimal STRINGS, not numbers, and can be long/high-precision (e.g.
// "0.0431328059369531392178303") — always parse with Number(), never assume a JS number arrives.
// The batch response is a MAP keyed by address, not the array the spec implied.
//
// Batching is the whole point of using this over the single-address endpoint — ElectroSwap's own
// docs are explicit that looping individual calls costs meaningfully more (20 singles: 1,000
// credits vs. one batch of 20: 300) — so getBatchTokenPrices below is what's actually meant to be
// used at scale; getTokenPrice exists for the rare single-lookup case.
//
// Every function here degrades to "return nothing, let the caller fall back" rather than throwing
// out to a caller that doesn't expect it — ELECTROSWAP_API_KEY may not be configured everywhere
// this runs, ElectroSwap may not have a price for a given token, and a failed call costs zero
// credits on their side (confirmed live: an insufficient-credits error reported "Nothing was
// executed and nothing was charged") — so there's no real cost to trying and falling back, and
// every caller integrating this keeps its existing on-chain/GeckoTerminal pricing as the fallback,
// never a new hard dependency.
import { ethers } from "ethers";

const BASE_URL = process.env.ELECTROSWAP_API_BASE_URL || "https://electroswap.io/public-api/v1";
const API_KEY = process.env.ELECTROSWAP_API_KEY;
const CHAIN_ID = 52014; // the only value ElectroSwap's API accepts — Electroneum mainnet
const FETCH_TIMEOUT_MS = 15000;
// Confirmed live: /prices/{chainId} accepts up to 50 addresses per call (matches the docs' own
// stated max) — a caller passing more gets chunked into multiple calls here, not one oversized
// request that would presumably just get rejected or truncated.
const MAX_BATCH_ADDRESSES = 50;

export function isElectroSwapConfigured() {
  return Boolean(API_KEY);
}

let loggedMissingKeyOnce = false;

async function callElectroSwapApi(path) {
  if (!API_KEY) {
    if (!loggedMissingKeyOnce) {
      console.log("ℹ️  ELECTROSWAP_API_KEY not set — ElectroSwap pricing disabled, falling back to existing on-chain/GeckoTerminal pricing everywhere it's used.");
      loggedMissingKeyOnce = true;
    }
    return null;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Confirmed live: a failed call (including insufficient_credits) costs zero credits on their
    // side — safe to throw here and let the caller fall back without worrying about wasted spend.
    const message = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`ElectroSwap API error: ${message}`);
  }
  return json?.data ?? null;
}

function parsePriceEntry(entry) {
  if (!entry) return null;
  const usd = Number(entry.usd);
  const etn = Number(entry.etn);
  if (!Number.isFinite(usd) && !Number.isFinite(etn)) return null;
  return { usd: Number.isFinite(usd) ? usd : null, etn: Number.isFinite(etn) ? etn : null };
}

/** `{ usd, etn }` price for ONE token — 50 credits per call. Prefer getBatchTokenPrices for more
 * than a couple of tokens (see this file's own header comment on why). Returns null — never
 * throws — if ELECTROSWAP_API_KEY isn't configured, ElectroSwap doesn't price this token, or the
 * call fails; callers should fall back to this app's existing on-chain/GeckoTerminal pricing in
 * every case. Either field can independently be null if ElectroSwap's own response only carried
 * one of the two (not observed live, but the response schema doesn't guarantee both are always
 * present). */
export async function getTokenPrice(tokenAddress) {
  try {
    const data = await callElectroSwapApi(`/prices/${CHAIN_ID}/${tokenAddress}`);
    return parsePriceEntry(data);
  } catch (err) {
    console.warn(`⚠️  ElectroSwap price lookup failed for ${tokenAddress}:`, err.message);
    return null;
  }
}

/** Day/hour-bucketed OHLCV candles for one token — confirmed live against the real API:
 *   GET /tokens/{chainId}/{address}/candles?bucket=1d&limit=N
 *     -> { data: [{ time (unix SECONDS), open, close, high, low, volume, count }, ...], cursor }
 * Unlike /prices, these numeric fields come back as actual JSON numbers, not strings — confirmed
 * live, not assumed. `bucket` must be one of '1m'|'15m'|'1h'|'4h'|'1d'. Cost is 100 + 1/item
 * (max 600 credits, i.e. up to 500 items per call) — cheap relative to the /prices endpoints.
 * `limit` is capped at 500 server-side (a larger value is REJECTED with 400 INVALID_LIMIT, not
 * clamped — confirmed live) — confirmed live via the response's own `cursor` field that 500 is
 * also the true ceiling on how much history exists per pool this way: a cursor-less, at-the-cap
 * request came back with `cursor: null`, and per the API's own OpenAPI spec `cursor` is "the
 * cursor from a previous response" for paging further — a null cursor on the very FIRST page means
 * there is nothing further back to page to, not an unused mechanism. So this call reaches back to
 * a pool's actual creation for any pool younger than 500 days old, and no further, for one this
 * old or older. Returns null — never throws — on any failure (key unset, request error, empty
 * response); callers should fall back to this app's existing GeckoTerminal-backed data. */
export async function getCandles(tokenAddress, bucket, limit) {
  try {
    const data = await callElectroSwapApi(`/tokens/${CHAIN_ID}/${tokenAddress}/candles?bucket=${bucket}&limit=${limit}`);
    if (!Array.isArray(data) || data.length === 0) return null;
    return data
      .filter((c) => Number.isFinite(c?.time) && Number.isFinite(c?.close))
      .map((c) => ({
        time: c.time,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number.isFinite(c.volume) ? c.volume : null,
      }));
  } catch (err) {
    console.warn(`⚠️  ElectroSwap candles lookup failed for ${tokenAddress}:`, err.message);
    return null;
  }
}

/** `{ usd, etn }` price for up to MAX_BATCH_ADDRESSES tokens in ONE call — 100 + 10/token credits
 * (e.g. 20 tokens: 300 credits batched vs. 1,000 calling getTokenPrice in a loop). Chunks
 * automatically if given more than MAX_BATCH_ADDRESSES. Returns a Map keyed by LOWERCASED address
 * -> { usd, etn } — an address ElectroSwap doesn't have a price for is simply absent from the map,
 * never a fabricated 0 (same "omit rather than fake" convention this app's own pricing code
 * already follows everywhere else). Returns an empty Map — never throws — if
 * ELECTROSWAP_API_KEY isn't configured or every chunk's call fails; callers should treat a missing
 * address as "fall back to existing on-chain/GeckoTerminal pricing for just this one", not as a
 * reason to abandon pricing the whole wallet/request. */
export async function getBatchTokenPrices(tokenAddresses) {
  const prices = new Map();
  if (!isElectroSwapConfigured() || tokenAddresses.length === 0) return prices;

  const unique = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))].filter((a) => ethers.isAddress(a));
  for (let i = 0; i < unique.length; i += MAX_BATCH_ADDRESSES) {
    const chunk = unique.slice(i, i + MAX_BATCH_ADDRESSES);
    try {
      const data = await callElectroSwapApi(`/prices/${CHAIN_ID}?addresses=${chunk.join(",")}`);
      if (!data) continue;
      for (const [address, entry] of Object.entries(data)) {
        const parsed = parsePriceEntry(entry);
        if (parsed) prices.set(address.toLowerCase(), parsed);
      }
    } catch (err) {
      console.warn(`⚠️  ElectroSwap batch price lookup failed for ${chunk.length} token(s):`, err.message);
      // Continue to the next chunk rather than aborting the whole batch — a transient failure for
      // one chunk of up to 50 shouldn't also cost the OTHER chunks their prices.
    }
  }
  return prices;
}
