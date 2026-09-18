import { getTokenList, isElectroSwapConfigured } from "./electroSwapApi.js";
import { getTokenLiquidityCache, setTokenLiquidityCache } from "../state/tokenLiquidityState.js";

// Keeps a public JSON cache of every token ElectroSwap lists, with its total liquidity in USD —
// backs the free Tokens tab (TokenLeaderboard.jsx) sorting by liquidity and showing a $ figure per
// token, without every visitor's browser calling ElectroSwap directly. Same shape/purpose as
// tokenPriceCache.js, just for liquidity instead of price, and a single bulk call instead of a
// fixed whitelist — getTokenList's own "every listed token" already covers the whole set in one
// (comparatively cheap, 100 + 5/item) call, so there's no per-token address list to maintain here.
//
// ElectroSwap's own token-list item schema is NOT confirmed live (see electroSwapApi.js's own
// getTokenList comment — untyped Envelope.data, no funded key available to verify a real response
// while building this). extractAddress/extractLiquidityUsd below try the field names a token-list
// endpoint most plausibly uses and log once if NONE of them match anything, so a wrong guess is
// loud and fixable rather than silently leaving the cache permanently empty. A single item that
// doesn't parse never poisons the rest — it's just skipped.
const CACHE_INTERVAL_MS = process.env.TOKEN_LIQUIDITY_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_LIQUIDITY_CACHE_INTERVAL_MS, 10)
  : 900000; // 15 min — liquidity moves far slower than price, and this is a "sort order + rough
             // figure" feature, not a live trading number; no need for tokenPriceCache.js's 5 min.

let loggedUnrecognizedShapeOnce = false;

function extractAddress(raw) {
  return raw?.address || raw?.tokenAddress || raw?.contractAddress || null;
}

function extractLiquidityUsd(raw) {
  const value = raw?.liquidityUsd ?? raw?.liquidity ?? raw?.tvlUsd ?? raw?.tvl ?? raw?.totalLiquidityUsd;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const rawTokens = await getTokenList(100);
    if (rawTokens == null) {
      console.warn("⚠️  Token liquidity cache: ElectroSwap token list unavailable this cycle — keeping previous cache");
      return;
    }

    const liquidityUsd = {};
    let unrecognized = 0;
    for (const raw of rawTokens) {
      const address = extractAddress(raw);
      const liquidity = extractLiquidityUsd(raw);
      if (!address || liquidity == null) {
        unrecognized++;
        continue;
      }
      liquidityUsd[address.toLowerCase()] = liquidity;
    }

    if (unrecognized > 0 && !loggedUnrecognizedShapeOnce) {
      loggedUnrecognizedShapeOnce = true;
      console.warn(
        `⚠️  Token liquidity cache: ${unrecognized}/${rawTokens.length} item(s) didn't match any known address/liquidity field name. Raw keys of first unrecognized item:`,
        Object.keys(rawTokens.find((r) => !extractAddress(r) || extractLiquidityUsd(r) == null) || {})
      );
    }

    if (Object.keys(liquidityUsd).length === 0) {
      const previous = await getTokenLiquidityCache();
      if (previous?.liquidityUsd && Object.keys(previous.liquidityUsd).length > 0) {
        console.warn(`⚠️  Token liquidity cache: no tokens parsed this cycle — keeping previous data from ${previous.updatedAt}`);
      } else {
        console.warn("⚠️  Token liquidity cache: no liquidity data available yet (nothing to publish)");
      }
      return;
    }

    await setTokenLiquidityCache(liquidityUsd);
    console.log(`💧 Token liquidity cache updated — ${Object.keys(liquidityUsd).length}/${rawTokens.length} token(s)`);
  } catch (err) {
    console.error("⚠️  Token liquidity cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured (nowhere public to publish
 * to) or ElectroSwap isn't configured (no liquidity source at all).
 */
export function startTokenLiquidityCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — token liquidity cache disabled");
    return;
  }
  if (!isElectroSwapConfigured()) {
    console.log("ℹ️  ELECTROSWAP_API_KEY not set — token liquidity cache disabled");
    return;
  }

  console.log(`💧 Token liquidity cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
