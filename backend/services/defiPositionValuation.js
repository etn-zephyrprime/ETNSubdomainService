// backend/services/defiPositionValuation.js
//
// Live USD value of a wallet's currently-OPEN yield-farm / staking positions. Separate from (and a
// genuinely different question than) pnlEventBuilder.js's buildDefiFarmEvents, which treats a farm
// deposit as a FIFO "disposal" — money leaves inventory the moment it's staked, for cost-basis
// purposes — and has no live "what's this worth right now" concept at all. Combined Holdings /
// Total Portfolio Balance (portfolioValuation.js, useCombinedPortfolio.js) only ever read live
// WALLET token balances via Blockscout — funds moved into a farm/staking contract simply vanish
// from both of those views, which is the actual gap this fills.
//
// Two templates, matching pnlIngestion.js's own event-topic detection (no hardcoded contract
// address list there, and none here either — every contract this checks comes from a wallet's own
// defi_activity rows):
//
//   - YieldFarm: getFarmerByFarmIdAndAddress(farmId, wallet).liquidity is a genuine Uniswap V3
//     concentrated-liquidity amount — confirmed live against a real deployed farm and a real open
//     position. Every farm this app template produces is full-range (tickLower/tickUpper at the
//     template's fixed extremes, confirmed live across multiple farms), which collapses the
//     standard V3 "amount from liquidity" formula to:
//       amount0 = liquidity / sqrtPrice, amount1 = liquidity * sqrtPrice
//     (the exact formula's sqrtPriceLower/Upper terms drop out because they're ~0/~infinity at
//     these tick extremes — the error from using the simplified form instead of the exact bounds is
//     many orders of magnitude below display precision). isFullRangeFarm below is a hard guard, not
//     a formality: if a farm is EVER deployed with a narrower range, this skips it rather than
//     silently applying a formula that would be wrong for it — see that function's own comment.
//   - CoreAscension staking: getUser(wallet).coreStaked is a single, direct current-balance read —
//     no LP math needed at all.
//
// Discovery (which farms/stakes to even check) comes from defi_activity — see
// getDistinctFarmPositions/getDistinctStakingContracts in defiActivity.js — NOT from brute-force
// scanning farm IDs on every known farm contract: confirmed live that a YieldFarm contract's own
// farmCount() undercounted the real number of farms deployed on it, so looping 0..farmCount()-1
// alone missed a real, currently-open position at a higher id. The CURRENT amount itself is always
// a fresh on-chain read, though — defi_activity only ever says WHERE to look, never what a position
// is currently worth (a withdraw row doesn't necessarily mean fully closed — could be partial; the
// live liquidity/coreStaked read is the only source of truth for "is this still open").
//
// getOpenDefiPositionsUsd calls pnlIngestion.js's ensureDefiActivityIngested FIRST, every time —
// nothing else on the Portfolio page (which is what actually calls this) ever populates
// defi_activity at all otherwise, that only happens as a side effect of ingestWalletHistory, called
// from the PnL Statement/Snapshot features. Without this, a member who only ever uses Portfolio
// would never see a farm/staking position surface, with no indication why — confirmed live this
// was exactly what was happening for a real wallet before this was added.
import { ethers } from "ethers";
import Decimal from "decimal.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { getTokenMetadata, ensureDefiActivityIngested } from "./pnlIngestion.js";
import { getDistinctFarmPositions, getDistinctStakingContracts } from "../db/defiActivity.js";

const YIELD_FARM_ABI = [
  "function getFarmById(uint256 _farmId) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))",
  "function getFarmerByFarmIdAndAddress(uint256 _farmId, address _farmerAddress) view returns (tuple(address addr, uint256 liquidity, uint256 boltMultiplier, uint256 boltDeposited, uint256 durationMultiplier, uint256 startingBlock, uint256 rewards, uint256 rewardDebt, uint256 thirdPartyRewards, uint256 thirdPartyRewardDebt, uint256 fees0, uint256 fees0Debt, uint256 fees1, uint256 fees1Debt))",
];
const POOL_V3_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const CORE_ASCENSION_ABI = [
  "function getUser(address account) view returns (uint256 coreStaked, uint256 nftCount, uint256 rewardWeight, uint256 entryTime, uint256 pendingRewards, bool currentlyEarly, uint256 boostBps)",
  "function core() view returns (address)",
];

const Q96 = 2n ** 96n;
// Guard for the simplified full-range formula (see this file's own header comment) — a farm's own
// tick bounds have to be at LEAST this extreme in both directions to trust it. Comfortably inside
// the true Uniswap V3 min/max tick (±887272) while still excluding anything that's a genuinely
// narrow, concentrated range (where the simplified formula would be meaningfully wrong).
const FULL_RANGE_TICK_ABS_MIN = 800000n;

let sharedProvider = null;
function getProvider() {
  if (!sharedProvider) sharedProvider = createRpcProvider({ batchMaxCount: 1 });
  return sharedProvider;
}

// Farm metadata (poolAddr/token0/token1/tickLower/tickUpper/name) never changes post-deploy —
// cached indefinitely per (contract, farmId), same "resolve once" pattern as pnlEventBuilder.js's
// own getFarmTokens (which this deliberately doesn't share, since that cache only stores
// token0/token1/name — this needs the tick bounds too, for the full-range guard).
const farmMetaCache = new Map(); // `${contract}:${farmId}` -> meta | null
async function getFarmMeta(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (farmMetaCache.has(key)) return farmMetaCache.get(key);
  let meta = null;
  try {
    const farm = new ethers.Contract(contractAddress, YIELD_FARM_ABI, getProvider());
    const f = await farm.getFarmById(farmId);
    meta = { poolAddr: f.poolAddr, token0: f.token0, token1: f.token1, tickLower: f.tickLower, tickUpper: f.tickUpper, name: f.name || null };
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: couldn't read farm metadata for ${contractAddress}#${farmId}:`, err.message);
  }
  farmMetaCache.set(key, meta);
  return meta;
}

function isFullRangeFarm(meta) {
  return meta.tickLower <= -FULL_RANGE_TICK_ABS_MIN && meta.tickUpper >= FULL_RANGE_TICK_ABS_MIN;
}

// Same "live ETN price, then convert to USD" two-step every other live-pricing call site in this
// app uses (see coreClashSwapWatcher.js's fetchWetnUsd) rather than a third independent USD-pricing
// path — getTokenEtnPrice already does the pool-discovery/liquidity-ranking work, this only adds
// the ETN->USD leg.
async function getLiveTokenUsdPrice(tokenAddress) {
  const [etnPrice, etnUsdCache] = await Promise.all([getTokenEtnPrice(getProvider(), tokenAddress), getEtnPriceCache()]);
  const etnUsd = etnUsdCache?.usd;
  if (etnPrice == null || !Number.isFinite(etnUsd) || etnUsd <= 0) return null;
  return etnPrice * etnUsd;
}

async function decimalsFor(tokenAddress) {
  const meta = await getTokenMetadata(tokenAddress);
  // getTokenMetadata doesn't carry decimals (name/symbol only) — a direct, cached-by-ethers-per-
  // process call is cheap enough here (one-time per token, not per wallet) not to warrant its own
  // cache layer.
  try {
    const token = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], getProvider());
    return Number(await token.decimals());
  } catch {
    return 18; // same fallback convention as the rest of this app's token-amount formatting
  }
}

/** One open YieldFarm position's current value, or null if it's fully withdrawn (liquidity 0),
 * isn't full-range (see isFullRangeFarm — never guesses), or any read along the way fails. Never
 * throws — a single bad position shouldn't blank the rest of a wallet's DeFi valuation. */
async function valueYieldFarmPosition(contractAddress, farmId, walletAddress) {
  try {
    const farm = new ethers.Contract(contractAddress, YIELD_FARM_ABI, getProvider());
    const farmer = await farm.getFarmerByFarmIdAndAddress(farmId, walletAddress);
    if (farmer.liquidity === 0n) return null; // fully withdrawn — nothing open here anymore

    const meta = await getFarmMeta(contractAddress, farmId);
    if (!meta) return null;
    if (!isFullRangeFarm(meta)) {
      console.warn(
        `⚠️  DeFi position valuation: farm ${farmId}@${contractAddress} (${meta.name || "unnamed"}) isn't full-range ` +
          `(tickLower=${meta.tickLower}, tickUpper=${meta.tickUpper}) — skipping rather than applying a formula that isn't valid for it.`
      );
      return null;
    }

    const pool = new ethers.Contract(meta.poolAddr, POOL_V3_ABI, getProvider());
    const slot0 = await pool.slot0();
    const sqrtPriceX96 = slot0.sqrtPriceX96;
    if (sqrtPriceX96 === 0n) return null; // uninitialized pool — nothing sane to compute

    const amount0Raw = (farmer.liquidity * Q96) / sqrtPriceX96;
    const amount1Raw = (farmer.liquidity * sqrtPriceX96) / Q96;

    const [decimals0, decimals1] = await Promise.all([decimalsFor(meta.token0), decimalsFor(meta.token1)]);
    const amount0 = new Decimal(ethers.formatUnits(amount0Raw, decimals0));
    const amount1 = new Decimal(ethers.formatUnits(amount1Raw, decimals1));

    const [price0, price1] = await Promise.all([getLiveTokenUsdPrice(meta.token0), getLiveTokenUsdPrice(meta.token1)]);
    const usd0 = price0 != null ? amount0.times(price0) : null;
    const usd1 = price1 != null ? amount1.times(price1) : null;
    const [meta0, meta1] = await Promise.all([getTokenMetadata(meta.token0), getTokenMetadata(meta.token1)]);

    return {
      kind: "farm",
      label: meta.name || `Yield Farm #${farmId}`,
      contractAddress,
      farmId,
      legs: [
        { tokenAddress: meta.token0, symbol: meta0?.symbol || null, amount: amount0.toString(), usdValue: usd0?.toString() ?? null },
        { tokenAddress: meta.token1, symbol: meta1?.symbol || null, amount: amount1.toString(), usdValue: usd1?.toString() ?? null },
      ],
      totalUsd: usd0 != null && usd1 != null ? usd0.plus(usd1).toString() : null,
      hasUnpriced: usd0 == null || usd1 == null,
    };
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: failed for farm ${farmId}@${contractAddress}:`, err.message);
    return null;
  }
}

/** One open CoreAscension staking position's current value, or null if fully withdrawn or any read
 * fails. Never throws — same reasoning as valueYieldFarmPosition. */
async function valueStakingPosition(contractAddress, walletAddress) {
  try {
    const staking = new ethers.Contract(contractAddress, CORE_ASCENSION_ABI, getProvider());
    const [user, coreTokenAddress] = await Promise.all([staking.getUser(walletAddress), staking.core()]);
    if (user.coreStaked === 0n) return null;

    const [decimals, meta, priceUsd] = await Promise.all([
      decimalsFor(coreTokenAddress),
      getTokenMetadata(coreTokenAddress),
      getLiveTokenUsdPrice(coreTokenAddress),
    ]);
    const amount = new Decimal(ethers.formatUnits(user.coreStaked, decimals));
    const usdValue = priceUsd != null ? amount.times(priceUsd) : null;

    return {
      kind: "staking",
      label: "Core Ascension Staking",
      contractAddress,
      farmId: null,
      legs: [{ tokenAddress: coreTokenAddress, symbol: meta?.symbol || null, amount: amount.toString(), usdValue: usdValue?.toString() ?? null }],
      totalUsd: usdValue?.toString() ?? null,
      hasUnpriced: usdValue == null,
    };
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: failed for staking contract ${contractAddress}:`, err.message);
    return null;
  }
}

/**
 * Every currently-OPEN farm/staking position for `trackedWallet`, with a live USD value each — the
 * missing piece behind Combined Holdings / Total Portfolio Balance not reflecting staked/farmed
 * funds (see this file's own header comment). Returns `{ positions, totalUsd, hasUnpriced }` —
 * `positions` is `[]` (not an error) for a wallet with no DeFi activity at all, or none still open.
 * `totalUsd` is a Decimal (or null if every open position is unpriced) — sum of only the priced
 * positions/legs, following this app's own "omit rather than fake" convention throughout; a member
 * whose 3 farm legs are only 2/3 priced still sees SOMETHING here, flagged incomplete via
 * `hasUnpriced`, not a blank stretch.
 */
export async function getOpenDefiPositionsUsd(trackedWallet) {
  // Discovery comes from defi_activity, which nothing on the Portfolio page otherwise ever
  // populates (that only happens as a side effect of ingestWalletHistory, called from the PnL
  // Statement/Snapshot features) — without this, a member who only ever uses Portfolio would never
  // see their farm/staking positions surface at all, with no indication why. Same cost profile as
  // PnL's own cold-start DeFi scan the first time this runs for a wallet (a real, possibly-slow
  // full-history topic scan); cheap on every call after that (just "anything new since last time").
  try {
    await ensureDefiActivityIngested(trackedWallet);
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: activity ingestion failed for ${trackedWallet}, using whatever's already recorded:`, err.message);
  }

  const [farmCandidates, stakingCandidates] = await Promise.all([
    getDistinctFarmPositions(trackedWallet),
    getDistinctStakingContracts(trackedWallet),
  ]);
  if (farmCandidates.length === 0 && stakingCandidates.length === 0) {
    return { positions: [], totalUsd: null, hasUnpriced: false };
  }

  const results = await Promise.all([
    ...farmCandidates.map((c) => valueYieldFarmPosition(c.contractAddress, c.farmId, trackedWallet)),
    ...stakingCandidates.map((c) => valueStakingPosition(c, trackedWallet)),
  ]);
  const positions = results.filter((p) => p != null);

  let totalUsd = null;
  let hasUnpriced = false;
  for (const p of positions) {
    if (p.hasUnpriced) hasUnpriced = true;
    if (p.totalUsd != null) totalUsd = (totalUsd ?? new Decimal(0)).plus(p.totalUsd);
  }

  // Stringified at this boundary (not left as a Decimal instance) so every caller — whether it
  // reads this directly (portfolioValuation.js, via Number()) or relays it through an HTTP JSON
  // response (premiumDashboardRouter.js) — sees the same plain, unambiguous type, matching this
  // codebase's own convention elsewhere (e.g. pnlSnapshotService.js's return shape).
  return { positions, totalUsd: totalUsd?.toString() ?? null, hasUnpriced };
}
