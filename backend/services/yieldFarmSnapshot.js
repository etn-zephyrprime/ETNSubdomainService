// backend/services/yieldFarmSnapshot.js
//
// Core Tier "Yield Farms" tab: every ElectroSwap yield farm, which wallets are in it, and how much of
// each token each one still has in it right now. Read live from the YieldFarm contract:
//   - farmCount() / getFarmById(id): the farm's pool, tokens, range, total liquidity, farmerCount
//     (its `farmers` array comes back EMPTY from getFarmById — confirmed live 2 Nov 2026 — so the
//     farmers are walked by index instead)
//   - getFarmerByFarmIdAndIndex(id, i): the i-th farmer's address
//   - getFarmerByFarmIdAndAddress(id, address): that farmer's position (liquidity) — a wallet with 0
//     liquidity has fully withdrawn and is left out
// Each farmer's liquidity becomes token amounts at the pool's live price with the standard V3 maths
// (every farm so far is full range: amount0 = L / sqrtP, amount1 = L * sqrtP). Confirmed live that
// the farmers' liquidity adds up exactly to the farm's own total. Principal only — pending rewards
// and uncollected fees aren't included.
//
// ~85 farmers across the active farms = ~170 reads, so the whole snapshot is cached for
// CACHE_MS and concurrent requests share one in-flight read.
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { v3Amounts } from "./lpCompositionHistory.js";
import { YIELD_FARM_ADDRESS } from "./scenarioRewards.js";

const CACHE_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;
const WETN = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const FULL_RANGE_TICK = 880000;

const FARMER = "tuple(address addr, uint256 liquidity, uint256 boltMultiplier, uint256 boltDeposited, uint256 durationMultiplier, uint256 startingBlock, uint256 rewards, uint256 rewardDebt, uint256 thirdPartyRewards, uint256 thirdPartyRewardDebt, uint256 fees0, uint256 fees0Debt, uint256 fees1, uint256 fees1Debt)";
const FARM_ABI = [
  "function farmCount() view returns (uint256)",
  "function getFarmById(uint256) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))",
  `function getFarmerByFarmIdAndIndex(uint256, uint256) view returns (${FARMER})`,
  `function getFarmerByFarmIdAndAddress(uint256, address) view returns (${FARMER})`,
];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)"];
const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const metaCache = new Map();
async function tokenMeta(provider, address) {
  const a = address.toLowerCase();
  if (!metaCache.has(a)) {
    const c = new ethers.Contract(a, ERC20, provider);
    const [symbol, decimals] = await Promise.all([c.symbol().catch(() => "?"), c.decimals().then(Number).catch(() => 18)]);
    metaCache.set(a, { address: a, symbol: a === WETN ? "ETN" : symbol, decimals });
  }
  return metaCache.get(a);
}

async function readSnapshot() {
  const provider = createRpcProvider();
  const farmC = new ethers.Contract(YIELD_FARM_ADDRESS, FARM_ABI, provider);
  const count = Number(await farmC.farmCount());
  const farms = [];
  for (let id = 1; id <= count; id++) {
    const f = await farmC.getFarmById(id);
    const farmerCount = Number(f.farmerCount);
    if (farmerCount === 0 || f.liquidity === 0n) continue;
    const [m0, m1, slot] = await Promise.all([tokenMeta(provider, f.token0), tokenMeta(provider, f.token1), new ethers.Contract(f.poolAddr, POOL_ABI, provider).slot0()]);
    const fullRange = Number(f.tickLower) <= -FULL_RANGE_TICK && Number(f.tickUpper) >= FULL_RANGE_TICK;
    const amountsOf = (L) => v3Amounts(L, slot.sqrtPriceX96, fullRange ? null : Number(f.tickLower), fullRange ? null : Number(f.tickUpper), m0.decimals, m1.decimals);

    const addresses = await mapLimited([...Array(farmerCount).keys()], CONCURRENCY, async (i) => (await farmC.getFarmerByFarmIdAndIndex(id, i)).addr);
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const positions = await mapLimited(unique, CONCURRENCY, async (addr) => {
      const farmer = await farmC.getFarmerByFarmIdAndAddress(id, addr);
      return { address: addr, liquidity: farmer.liquidity };
    });
    const total = f.liquidity;
    const farmers = positions
      .filter((p) => p.liquidity > 0n)
      .map((p) => ({ address: p.address, ...amountsOf(p.liquidity), sharePct: Number((p.liquidity * 1000000n) / total) / 10000 }))
      .sort((a, b) => b.sharePct - a.sharePct);
    farms.push({
      id,
      name: f.name || `${m0.symbol}/${m1.symbol}`,
      active: f.active,
      pool: f.poolAddr.toLowerCase(),
      token0: { address: m0.address, symbol: m0.symbol },
      token1: { address: m1.address, symbol: m1.symbol },
      fullRange,
      total: amountsOf(total),
      priceToken1PerToken0: (Number(slot.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (m0.decimals - m1.decimals),
      farmers,
    });
  }
  return { asOf: new Date().toISOString(), contract: YIELD_FARM_ADDRESS, farms };
}

let cached = null;
let inFlight = null;
/** The latest snapshot (cached CACHE_MS; concurrent callers share one read). */
export async function getYieldFarmSnapshot() {
  if (cached && Date.now() - Date.parse(cached.asOf) < CACHE_MS) return cached;
  if (!inFlight) {
    inFlight = readSnapshot()
      .then((s) => (cached = s))
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
