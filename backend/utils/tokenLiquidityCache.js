import { ethers } from "ethers";
import { getPools, getBatchTokenPrices, isElectroSwapConfigured } from "./electroSwapApi.js";
import { getTokenLiquidityCache, setTokenLiquidityCache } from "../state/tokenLiquidityState.js";
import { createRpcProvider } from "./rpcProvider.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";

// Keeps a public JSON cache of total liquidity (USD) per token — backs the free Tokens tab
// (TokenLeaderboard.jsx) sorting/display. Confirmed live (2026-09-18, real funded key) that
// ElectroSwap's public API has NO liquidity/TVL field anywhere: not on the bulk token list, not on
// /tokens/{chainId}/{address}, and not on /pools/{chainId} either (that one gives only the pool's
// address and its two tokens' identity/metadata — see getPools's own comment for the exact
// confirmed shape). An earlier version of this file assumed the bulk token list carried a
// liquidity-ish field and guessed at its name; it didn't exist at all, confirmed via a real
// production log showing every field the API actually returns.
//
// So liquidity here is COMPUTED, not fetched: get the pool list from ElectroSwap (cheap, one call
// per version), then read each pool's actual current token balances directly on-chain via
// `balanceOf` — this works identically for a V2 or a V3 pool (a V3 pool's real holdings are its own
// token balances regardless of how its concentrated-liquidity accounting works internally, so this
// deliberately avoids reimplementing lpPositionValuation.js's own V3 tick-math, which values one
// SPECIFIC position, not a whole pool's total holdings) — then value those balances with
// ElectroSwap's own per-token USD prices (already-built getBatchTokenPrices, same as
// tokenPriceCache.js uses). A pool where either side's price is unavailable is skipped entirely
// rather than guessed at.
//
// Refreshed hourly, not on tokenPriceCache.js's 5-minute cadence — confirmed acceptable per
// explicit direction: liquidity doesn't move anywhere near as fast as price, and this keeps both
// the ElectroSwap credit spend (two /pools calls/hour, ~700 credits each at 100 pools) and the RPC
// volume (two balanceOf reads per pool) low.
const CACHE_INTERVAL_MS = process.env.TOKEN_LIQUIDITY_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_LIQUIDITY_CACHE_INTERVAL_MS, 10)
  : 3600000; // 1 hour

// Same address lpPositionValuation.js's own WETN_ADDRESS uses, same reasoning: ETN/WETN are 1:1
// pegged, and WETN is the base pairing asset in most of this DEX's own pools (confirmed live — see
// the sample /pools response in this repo's own "electroswap-api" memory), so getting its price
// right matters far more than any other single token here. Asking ElectroSwap to price WETN
// against itself would be structurally pointless (there's no such pool) and would just come back
// empty — substituted with the direct ETN/USD rate instead, same as that file does.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

const RESERVE_READ_CONCURRENCY = 8; // same bounded-worker-pool convention as activatedDomainsCache.js's own VERIFY_CONCURRENCY
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const [poolsV2, poolsV3] = await Promise.all([getPools(2, 100), getPools(3, 100)]);
    const pools = [...(poolsV2 || []), ...(poolsV3 || [])];

    if (pools.length === 0) {
      console.warn("⚠️  Token liquidity cache: no pools returned this cycle — keeping previous cache");
      return;
    }

    const tokenAddresses = new Set();
    for (const pool of pools) {
      if (pool?.token0?.address) tokenAddresses.add(pool.token0.address.toLowerCase());
      if (pool?.token1?.address) tokenAddresses.add(pool.token1.address.toLowerCase());
    }

    const priceMap = await getBatchTokenPrices([...tokenAddresses]);
    const etnPriceCache = await getEtnPriceCache().catch(() => null);
    if (Number.isFinite(etnPriceCache?.usd) && etnPriceCache.usd > 0) {
      priceMap.set(WETN_ADDRESS, { usd: etnPriceCache.usd, etn: 1 });
    }

    const provider = createRpcProvider({ batchMaxCount: 1 });
    const liquidityUsd = {};
    let readFailures = 0;
    let unpriced = 0;

    await mapWithConcurrency(pools, RESERVE_READ_CONCURRENCY, async (pool) => {
      const { address, token0, token1 } = pool || {};
      if (!address || !token0?.address || !token1?.address) return;

      const price0 = priceMap.get(token0.address.toLowerCase())?.usd;
      const price1 = priceMap.get(token1.address.toLowerCase())?.usd;
      if (price0 == null || price1 == null) {
        unpriced++;
        return; // can't value this pool without both sides priced — omit rather than guess
      }

      try {
        const t0 = new ethers.Contract(token0.address, ERC20_BALANCE_ABI, provider);
        const t1 = new ethers.Contract(token1.address, ERC20_BALANCE_ABI, provider);
        const [bal0, bal1] = await Promise.all([t0.balanceOf(address), t1.balanceOf(address)]);

        const amount0 = Number(ethers.formatUnits(bal0, token0.decimals ?? 18));
        const amount1 = Number(ethers.formatUnits(bal1, token1.decimals ?? 18));
        if (!Number.isFinite(amount0) || !Number.isFinite(amount1)) return;

        // Full pool TVL credited to EACH of its two tokens — same convention DEX aggregators
        // generally use ("this token has $X liquidity" means the pool(s) it's paired in hold $X
        // total, not just this token's own half) — a token in several pools accumulates across all
        // of them.
        const poolLiquidityUsd = amount0 * price0 + amount1 * price1;
        if (!Number.isFinite(poolLiquidityUsd) || poolLiquidityUsd < 0) return;

        const t0Addr = token0.address.toLowerCase();
        const t1Addr = token1.address.toLowerCase();
        liquidityUsd[t0Addr] = (liquidityUsd[t0Addr] || 0) + poolLiquidityUsd;
        liquidityUsd[t1Addr] = (liquidityUsd[t1Addr] || 0) + poolLiquidityUsd;
      } catch (err) {
        readFailures++;
        console.warn(`⚠️  Token liquidity cache: failed to read balances for pool ${address}:`, err.message);
      }
    });

    if (Object.keys(liquidityUsd).length === 0) {
      const previous = await getTokenLiquidityCache();
      if (previous?.liquidityUsd && Object.keys(previous.liquidityUsd).length > 0) {
        console.warn(`⚠️  Token liquidity cache: no pools valued this cycle (${unpriced} unpriced, ${readFailures} read failure(s)) — keeping previous data from ${previous.updatedAt}`);
      } else {
        console.warn("⚠️  Token liquidity cache: no liquidity data available yet (nothing to publish)");
      }
      return;
    }

    await setTokenLiquidityCache(liquidityUsd);
    console.log(
      `💧 Token liquidity cache updated — ${Object.keys(liquidityUsd).length} token(s) across ${pools.length} pool(s)` +
        (unpriced > 0 || readFailures > 0 ? ` (${unpriced} unpriced, ${readFailures} read failure(s))` : "")
    );
  } catch (err) {
    console.error("⚠️  Token liquidity cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured (nowhere public to publish
 * to) or ElectroSwap isn't configured (no pool list source at all).
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
