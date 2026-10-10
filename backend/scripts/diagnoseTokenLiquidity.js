// backend/scripts/diagnoseTokenLiquidity.js
//
// Answers "why does the Tokens tab show $X liquidity for this token?" by printing the exact
// per-pool breakdown tokenLiquidityCache.js sums into that one published figure — same
// getPools/priceMap/balanceOf logic, just for one token and with every pool shown individually
// instead of folded into a single number.
//
// Written because tokenLiquidityCache.js's own liquidity figure is a SUM across every pool the
// token appears in (each pool's full two-sided TVL credited to both of its tokens — see that
// file's own comment) — for a token that's the base pairing asset in many pools (WETN, on this
// DEX), the published number can look like "this token's own pool" when it's actually several
// pools' totals added together. This makes that addition visible instead of just asserting it.
//
// Usage:
//   node backend/scripts/diagnoseTokenLiquidity.js <tokenAddress>
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPools, getBatchTokenPrices } from "../utils/electroSwapApi.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";

dotenv.config();

const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77"; // same as tokenLiquidityCache.js's own constant
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const target = (process.argv[2] || "").toLowerCase();
  if (!ethers.isAddress(target)) {
    throw new Error("Usage: node backend/scripts/diagnoseTokenLiquidity.js <tokenAddress>");
  }

  const [poolsV2, poolsV3] = await Promise.all([getPools(2, 100), getPools(3, 100)]);
  const pools = [...(poolsV2 || []), ...(poolsV3 || [])];
  if (pools.length === 0) throw new Error("ElectroSwap returned no pools — check ELECTROSWAP_API_KEY.");

  const matching = pools.filter(
    (p) => p?.token0?.address?.toLowerCase() === target || p?.token1?.address?.toLowerCase() === target
  );
  if (matching.length === 0) {
    console.log(`No pools found pairing ${target}.`);
    return;
  }

  const tokenAddresses = new Set();
  for (const pool of matching) {
    if (pool?.token0?.address) tokenAddresses.add(pool.token0.address.toLowerCase());
    if (pool?.token1?.address) tokenAddresses.add(pool.token1.address.toLowerCase());
  }
  const priceMap = await getBatchTokenPrices([...tokenAddresses]);
  const etnPriceCache = await getEtnPriceCache().catch(() => null);
  if (Number.isFinite(etnPriceCache?.usd) && etnPriceCache.usd > 0) {
    priceMap.set(WETN_ADDRESS, { usd: etnPriceCache.usd, etn: 1 });
  }

  const provider = createRpcProvider({ batchMaxCount: 1 });

  // Same on-chain fallback tokenLiquidityCache.js now applies for a token ElectroSwap has no price
  // for at all (see that file's own comment) — kept in sync here so this diagnostic reflects what
  // the real cache actually does, instead of still showing SKIPPED for something the live cache
  // now successfully prices.
  if (Number.isFinite(etnPriceCache?.usd) && etnPriceCache.usd > 0) {
    for (const addr of tokenAddresses) {
      if (priceMap.get(addr)?.usd != null) continue;
      try {
        const etnPrice = await getTokenEtnPrice(provider, addr, { skipElectroSwap: true });
        if (etnPrice != null) priceMap.set(addr, { usd: etnPrice * etnPriceCache.usd, etn: etnPrice });
      } catch (err) {
        console.warn(`⚠️  on-chain fallback price failed for ${addr}:`, err.message);
      }
    }
  }

  let total = 0;
  console.log(`${matching.length} pool(s) pair ${target}:\n`);

  for (const pool of matching) {
    const { address, token0, token1 } = pool;
    const price0 = priceMap.get(token0.address.toLowerCase())?.usd;
    const price1 = priceMap.get(token1.address.toLowerCase())?.usd;
    if (price0 == null || price1 == null) {
      console.log(`  ${address}: ${token0.symbol}/${token1.symbol} — SKIPPED (missing price for ${price0 == null ? token0.symbol : token1.symbol})`);
      continue;
    }
    try {
      const t0 = new ethers.Contract(token0.address, ERC20_BALANCE_ABI, provider);
      const t1 = new ethers.Contract(token1.address, ERC20_BALANCE_ABI, provider);
      const [bal0, bal1] = await Promise.all([t0.balanceOf(address), t1.balanceOf(address)]);
      const amount0 = Number(ethers.formatUnits(bal0, token0.decimals ?? 18));
      const amount1 = Number(ethers.formatUnits(bal1, token1.decimals ?? 18));
      const usd0 = amount0 * price0;
      const usd1 = amount1 * price1;
      const poolTotal = usd0 + usd1;
      total += poolTotal;
      console.log(
        `  ${address}: ${amount0.toLocaleString()} ${token0.symbol} ($${usd0.toLocaleString(undefined, { maximumFractionDigits: 0 })}) + ` +
          `${amount1.toLocaleString()} ${token1.symbol} ($${usd1.toLocaleString(undefined, { maximumFractionDigits: 0 })}) = ` +
          `$${poolTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} pool TVL`
      );
    } catch (err) {
      console.log(`  ${address}: FAILED to read balances — ${err.message}`);
    }
  }

  console.log(`\nSum of all pools above (this is the figure the Tokens tab shows): $${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
