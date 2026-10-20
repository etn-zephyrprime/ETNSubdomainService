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
import { getLastKnownPrice, recordLastKnownPrice } from "../utils/lastKnownPrices.js";
import { getTokenMetadata, ensureDefiActivityIngested } from "./pnlIngestion.js";
import { getDistinctFarmPositions, getDistinctStakingContracts, getFarmDepositedQuantities, getFarmPositionCycles } from "../db/defiActivity.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { getCachedPosition, upsertCachedPosition } from "../db/walletPositionCache.js";
import { setBounded, registerCache } from "../utils/boundedMap.js";
import { computeImpermanentLoss } from "./impermanentLoss.js";

const YIELD_FARM_ABI = [
  "function getFarmById(uint256 _farmId) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))",
  "function getFarmerByFarmIdAndAddress(uint256 _farmId, address _farmerAddress) view returns (tuple(address addr, uint256 liquidity, uint256 boltMultiplier, uint256 boltDeposited, uint256 durationMultiplier, uint256 startingBlock, uint256 rewards, uint256 rewardDebt, uint256 thirdPartyRewards, uint256 thirdPartyRewardDebt, uint256 fees0, uint256 fees0Debt, uint256 fees1, uint256 fees1Debt))",
  "function rewardPerBlock() view returns (uint256)",
  "function totalAllocPoint() view returns (uint256)",
  "function rewardToken() view returns (address)",
  "function getThirdPartyRewardConfigByFarmId(uint256 _farmId) view returns (tuple(address token, uint256 tokensPerBlock, uint256 endBlock))",
];
const POOL_V3_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const CORE_ASCENSION_ABI = [
  "function getUser(address account) view returns (uint256 coreStaked, uint256 nftCount, uint256 rewardWeight, uint256 entryTime, uint256 pendingRewards, bool currentlyEarly, uint256 boostBps)",
  "function core() view returns (address)",
];

const Q96 = 2n ** 96n;

// YieldFarm duration multiplier, from the contract's verified source (calculateDurationMultiplier):
// 10000 + 15000 × blocksHeld / MAX_BLOCKS_FOR_BONUS, capped at 25000 — i.e. 1.00× rising linearly to
// 2.50× over ~1 year of blocks since farmer.startingBlock (which a top-up deposit dilutes toward now).
// Computed live from the current block rather than read from farmer.durationMultiplier, which is a
// snapshot the contract only refreshes when the farmer interacts.
const DURATION_MULTIPLIER_BASE = 10000;
const DURATION_MULTIPLIER_RANGE = 15000;
const DURATION_MULTIPLIER_MAX = 25000;
const MAX_BLOCKS_FOR_BONUS = 6307200;
const SECONDS_PER_BLOCK = (365 * 24 * 3600) / MAX_BLOCKS_FOR_BONUS; // the contract sizes the bonus window as one year of blocks

/** { durationMultiplier, boltMultiplier, maxDurationMultiplier, maxReachedInDays } — multipliers as
 * plain numbers (1.734 = 1.734×). maxReachedInDays is 0 once at the cap. */
export function farmMultipliers(farmer, currentBlock) {
  const held = BigInt(currentBlock) > BigInt(farmer.startingBlock) ? BigInt(currentBlock) - BigInt(farmer.startingBlock) : 0n;
  let raw = DURATION_MULTIPLIER_BASE + Number((BigInt(DURATION_MULTIPLIER_RANGE) * held) / BigInt(MAX_BLOCKS_FOR_BONUS));
  if (raw > DURATION_MULTIPLIER_MAX) raw = DURATION_MULTIPLIER_MAX;
  const blocksToMax = Math.max(0, MAX_BLOCKS_FOR_BONUS - Number(held));
  return {
    durationMultiplier: raw / 10000,
    boltMultiplier: Number(farmer.boltMultiplier) > 0 ? Number(farmer.boltMultiplier) / 10000 : 1,
    maxDurationMultiplier: DURATION_MULTIPLIER_MAX / 10000,
    maxReachedInDays: raw >= DURATION_MULTIPLIER_MAX ? 0 : (blocksToMax * SECONDS_PER_BLOCK) / 86400,
  };
}
// Confirmed via this farm contract's own verified source (_collectRewardsAndFees): pendingFeesX =
// (farmer.liquidity * farm.accFeesXPerShare / CALC_PRECISION) - farmer.feesXDebt. Not guessed from
// the ABI struct's field names alone — this exact constant and formula were read directly off the
// deployed, verified contract (Blockscout) before trusting them for a user-facing figure.
const CALC_PRECISION = 10n ** 18n;
// Guard for the simplified full-range formula (see this file's own header comment) — a farm's own
// tick bounds have to be at LEAST this extreme in both directions to trust it. Comfortably inside
// the true Uniswap V3 min/max tick (±887272) while still excluding anything that's a genuinely
// narrow, concentrated range (where the simplified formula would be meaningfully wrong).
const FULL_RANGE_TICK_ABS_MIN = 800000n;

// Two-level cache for getOpenDefiPositionsUsd's own result, PLUS a persisted third level in
// Supabase (wallet_position_cache — see that migration's own header comment for the full picture).
// Confirmed live: with nothing cached at all, every single Core Tier reconnect/page load paid the
// full cost of this function (a live getFarmerByFarmIdAndAddress/getUser RPC read PLUS a live price
// lookup for every open position) — on the order of a minute for a wallet holding a few positions —
// even when nothing about that wallet's on-chain state had changed since the last load seconds
// earlier, and even on the very first load of a given day or right after a backend restart.
// Discovery (which contracts/farms to even check) already comes from defi_activity, ingested into
// Postgres — but the CURRENT VALUE of an open position was never cached anywhere, so "the data is
// in Supabase" didn't actually make this fast.
//
// L1 (positionsCache, in-memory): near-zero-latency repeat hits within one backend process's
// lifetime — resets on every restart/deploy.
// L2 (wallet_position_cache, Supabase, see getOpenDefiPositionsUsd below): survives restarts —
// this is what actually delivers "should appear immediately" even on the first request after a
// deploy or the first visit of the day, at the cost of one indexed DB read instead of zero.
// L3: the real live computation below, run only when nothing usable is cached at either level yet
// (a wallet's genuinely first-ever computation), OR silently in the background (never blocking the
// caller) to refresh an L2 row that's gone stale — see the `refreshing` flag on the returned result.
//
// Both levels are keyed off the SAME freshness signal: wallet_ingestion_state.updated_at. A farm/
// stake position's own on-chain amount only ever changes via a deposit/withdraw tx, and any such tx
// necessarily gets ingested into defi_activity first (bumping updated_at) before this function could
// see it anyway, so an unchanged updated_at means a cached row's quantities are still exactly
// correct — not just "last known" — same reasoning as pnlSnapshotService.js's own identical
// cache-key comment. Live PRICE movement is the only thing that can still have drifted, which is
// why a stale-fingerprint hit is served immediately (still real, still close) while a background
// refresh brings it fully current within moments.
const positionsCache = registerCache("defiPositions", new Map()); // walletAddress (lowercase) -> { result, computedAt: ms, ingestionUpdatedAt: ms|null }
const POSITIONS_CACHE_MAX_ENTRIES = 200; // any looked-up wallet can land here
const POSITIONS_CACHE_TTL_MS = process.env.DEFI_POSITIONS_CACHE_TTL_MS
  ? parseInt(process.env.DEFI_POSITIONS_CACHE_TTL_MS, 10)
  : 30000;
// Dedupes concurrent/rapid-fire background refreshes for the same wallet — same "in-flight promise
// as the dedup boundary" pattern pnlIngestion.js's own inFlightIngestions/inFlightDefiScans use, for
// the identical reason: several requests for the same stale wallet arriving close together (e.g. the
// Portfolio and PnL tabs both loading around the same time) should share ONE background recompute,
// not each kick off their own redundant one.
const inFlightRefresh = new Map(); // walletAddress (lowercase) -> Promise

let sharedProvider = null;
function getProvider() {
  if (!sharedProvider) sharedProvider = createRpcProvider({ batchMaxCount: 1 });
  return sharedProvider;
}

// Farm metadata (poolAddr/token0/token1/tickLower/tickUpper/name) never changes post-deploy — cached
// indefinitely per (contract, farmId) ONCE SUCCESSFULLY READ, same "resolve once" pattern as
// pnlEventBuilder.js's own getFarmTokens (which this deliberately doesn't share, since that cache
// only stores token0/token1/name — this needs the tick bounds too, for the full-range guard). A
// FAILED read (a transient RPC hiccup, a timeout) is never cached — same reasoning pnlPricing.js's
// own failedBackfillThisRun/failedPriceLookupThisRun already document: caching a null result
// indefinitely would silently and permanently hide that farm's positions for every wallet from then
// on, with no way to recover short of a redeploy. Confirmed live this was exactly what had happened
// to a real farm — a transient failure once, then every wallet's real, open position on it
// invisible forever after.
const farmMetaCache = new Map(); // `${contract}:${farmId}` -> meta (only ever set on success)
async function getFarmMeta(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (farmMetaCache.has(key)) return farmMetaCache.get(key);
  try {
    const farm = new ethers.Contract(contractAddress, YIELD_FARM_ABI, getProvider());
    const f = await farm.getFarmById(farmId);
    const meta = { poolAddr: f.poolAddr, token0: f.token0, token1: f.token1, tickLower: f.tickLower, tickUpper: f.tickUpper, name: f.name || null };
    farmMetaCache.set(key, meta);
    return meta;
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: couldn't read farm metadata for ${contractAddress}#${farmId}, will retry next call:`, err.message);
    return null;
  }
}

function isFullRangeFarm(meta) {
  return meta.tickLower <= -FULL_RANGE_TICK_ABS_MIN && meta.tickUpper >= FULL_RANGE_TICK_ABS_MIN;
}

// Same "live ETN price, then convert to USD" two-step every other live-pricing call site in this
// app uses (see coreClashSwapWatcher.js's fetchWetnUsd) rather than a third independent USD-pricing
// path — getTokenEtnPrice already does the pool-discovery/liquidity-ranking work, this only adds
// the ETN->USD leg.
async function getLiveTokenUsdPrice(tokenAddress) {
  // A live lookup that fails (rate-limited price sources) or comes back empty falls back to the last price this
  // token was successfully priced at (lastKnownPrices.js), so a staked/farmed position isn't valued at nothing —
  // and dropped from the portfolio total — for as long as the price sources are down.
  try {
    const [etnPrice, etnUsdCache] = await Promise.all([getTokenEtnPrice(getProvider(), tokenAddress), getEtnPriceCache()]);
    const etnUsd = etnUsdCache?.usd;
    if (etnPrice != null && Number.isFinite(etnUsd) && etnUsd > 0) {
      const usd = etnPrice * etnUsd;
      recordLastKnownPrice(tokenAddress, usd);
      return usd;
    }
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: live price lookup failed for ${tokenAddress}, trying last known:`, err.message);
  }
  return getLastKnownPrice(tokenAddress);
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

// Returned by the per-position valuers when a position COULD NOT be valued (a failed read, a rate-limited
// price lookup) — as opposed to null, which means "nothing open here" (withdrawn, zero staked). Kept apart so
// getOpenDefiPositionsUsd can tell "no position" from "position we failed to look at": a failure used to
// return null too, so a staked/farmed position silently VANISHED from the portfolio total whenever a price
// lookup was rate-limited, and the daily summary swung by that position's whole value with no warning.
const POSITION_FAILED = Symbol("position-failed");

/** One open YieldFarm position's current value, or null if it's fully withdrawn (liquidity 0),
 * isn't full-range (see isFullRangeFarm — never guesses), or any read along the way fails. Never
 * throws — a single bad position shouldn't blank the rest of a wallet's DeFi valuation.
 *
 * Each leg also carries a token-QUANTITY breakdown (depositedAmount/pendingFees/netAmount/
 * changePercent), separate from and in addition to the existing USD valuation — confirmed live
 * user concern: a position's USD value can read as "profitable" purely from ETN itself pumping,
 * even while the underlying token split has shifted unfavorably (classic impermanent loss, which a
 * USD-only figure hides). depositedAmount is the net "still locked" baseline (getFarmDepositedQuantities
 * — every deposit/top-up minus every withdrawal's principal, from this wallet's own defi_activity
 * ledger); pendingFees is this leg's trading fees accrued but not yet collected (confirmed via this
 * farm contract's own verified source — see CALC_PRECISION's own comment); netAmount is what you'd
 * walk away with if you collected and withdrew everything right now (current pool-attributable
 * amount + pending fees); changePercent compares netAmount against depositedAmount. */
async function valueYieldFarmPosition(contractAddress, farmId, walletAddress) {
  try {
    const farm = new ethers.Contract(contractAddress, YIELD_FARM_ABI, getProvider());
    const [farmer, currentBlock] = await Promise.all([farm.getFarmerByFarmIdAndAddress(farmId, walletAddress), getProvider().getBlockNumber()]);
    if (farmer.liquidity === 0n) return null; // fully withdrawn — nothing open here anymore

    const meta = await getFarmMeta(contractAddress, farmId);
    if (!meta) return POSITION_FAILED; // metadata read failed (logged in getFarmMeta) — not the same as "nothing open"
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

    // Pending (accrued, not yet collected) trading fees — see this function's own header comment
    // and CALC_PRECISION's. accFeesXPerShare changes continuously as the pool trades, so this needs
    // its own FRESH read every call — getFarmMeta's own cache only ever holds the farm's static
    // fields (poolAddr/token0/token1/tick bounds/name), deliberately never this. A failed read
    // degrades to "no fees counted" (0) rather than failing the whole position — the live USD/token
    // amounts above are still real and worth showing even if this one extra figure is unavailable.
    let pendingFees0 = new Decimal(0);
    let pendingFees1 = new Decimal(0);
    let pendingRewards = null; // { tokenAddress, symbol, amount } — the farm's own reward token
    let hasThirdPartyRewards = false;
    try {
      const farmState = await farm.getFarmById(farmId);
      // Pending farm rewards, replicating the contract's _updateFarmRewardsAndFees +
      // _collectRewardsAndFees (verified source) as of the current block: bring accRewardsPerShare
      // forward, take this farmer's share minus its debt, then apply BOLT x duration multipliers.
      try {
        const [rewardPerBlock, totalAllocPoint, rewardTokenAddress, thirdParty] = await Promise.all([
          farm.rewardPerBlock(),
          farm.totalAllocPoint(),
          farm.rewardToken(),
          farm.getThirdPartyRewardConfigByFarmId(farmId).catch(() => null),
        ]);
        let acc = farmState.accRewardsPerShare;
        if (farmState.liquidity > 0n && farmState.active && totalAllocPoint > 0n && BigInt(currentBlock) > farmState.lastCalcBlock) {
          const rewards = (BigInt(currentBlock) - farmState.lastCalcBlock) * ((rewardPerBlock * farmState.allocPoint) / totalAllocPoint);
          acc += (rewards * CALC_PRECISION) / farmState.liquidity;
        }
        let earned = (farmer.liquidity * acc) / CALC_PRECISION - farmer.rewardDebt;
        if (earned < 0n) earned = 0n;
        const blocksServed = BigInt(currentBlock) - BigInt(farmer.startingBlock);
        const durationRaw = blocksServed >= BigInt(MAX_BLOCKS_FOR_BONUS) ? BigInt(DURATION_MULTIPLIER_MAX) : BigInt(DURATION_MULTIPLIER_BASE) + (BigInt(DURATION_MULTIPLIER_RANGE) * blocksServed) / BigInt(MAX_BLOCKS_FOR_BONUS);
        const collected = (earned * farmer.boltMultiplier * durationRaw) / 100000000n;
        const [rewardDecimals, rewardMeta] = await Promise.all([decimalsFor(rewardTokenAddress), getTokenMetadata(rewardTokenAddress)]);
        pendingRewards = { tokenAddress: rewardTokenAddress, symbol: rewardMeta?.symbol || null, amount: ethers.formatUnits(collected, rewardDecimals) };
        hasThirdPartyRewards = Boolean(thirdParty && thirdParty.token !== ethers.ZeroAddress && (thirdParty.tokensPerBlock > 0n || farmer.thirdPartyRewardDebt > 0n));
      } catch (err) {
        console.warn(`⚠️  DeFi position valuation: couldn't compute pending rewards for farm ${farmId}@${contractAddress}:`, err?.shortMessage || err?.message);
      }
      let fees0Raw = (farmer.liquidity * farmState.accFees0PerShare) / CALC_PRECISION - farmer.fees0Debt;
      let fees1Raw = (farmer.liquidity * farmState.accFees1PerShare) / CALC_PRECISION - farmer.fees1Debt;
      if (fees0Raw < 0n) fees0Raw = 0n; // shouldn't happen given the contract's own debt accounting, but never show a negative "earned"
      if (fees1Raw < 0n) fees1Raw = 0n;
      pendingFees0 = new Decimal(ethers.formatUnits(fees0Raw, decimals0));
      pendingFees1 = new Decimal(ethers.formatUnits(fees1Raw, decimals1));
    } catch (err) {
      console.warn(`⚠️  DeFi position valuation: couldn't read pending fees for farm ${farmId}@${contractAddress}:`, err.message);
    }

    // Original "still locked" baseline — see getFarmDepositedQuantities's own comment.
    let depositedAmount0 = null;
    let depositedAmount1 = null;
    try {
      const { net0, net1 } = await getFarmDepositedQuantities(walletAddress, contractAddress, farmId);
      depositedAmount0 = new Decimal(ethers.formatUnits(net0, decimals0));
      depositedAmount1 = new Decimal(ethers.formatUnits(net1, decimals1));
    } catch (err) {
      console.warn(`⚠️  DeFi position valuation: couldn't read deposited baseline for farm ${farmId}@${contractAddress}:`, err.message);
    }

    const netAmount0 = amount0.plus(pendingFees0);
    const netAmount1 = amount1.plus(pendingFees1);
    // null (not 0%) when there's no sane baseline to compare against — a zero/negative deposited
    // amount (ledger gap, or a position opened before this wallet's own cold-start cursor) would
    // otherwise divide by zero or show a nonsensical figure.
    const changePercent0 = depositedAmount0 != null && depositedAmount0.gt(0) ? netAmount0.minus(depositedAmount0).dividedBy(depositedAmount0).times(100).toString() : null;
    const changePercent1 = depositedAmount1 != null && depositedAmount1.gt(0) ? netAmount1.minus(depositedAmount1).dividedBy(depositedAmount1).times(100).toString() : null;

    const [price0, price1] = await Promise.all([getLiveTokenUsdPrice(meta.token0), getLiveTokenUsdPrice(meta.token1)]);
    const usd0 = price0 != null ? amount0.times(price0) : null;
    const usd1 = price1 != null ? amount1.times(price1) : null;
    const [meta0, meta1] = await Promise.all([getTokenMetadata(meta.token0), getTokenMetadata(meta.token1)]);

    // USD value of JUST the token-quantity drift (netAmount - depositedAmount), priced at today's
    // rate — isolates "this many extra/fewer tokens is worth $X right now" from the overall totalUsd
    // figure above, which also moves with the token's own price and so can't be read as "the
    // quantity shift's dollar effect" on its own. Null whenever either input needed to compute it is
    // (no deposited baseline, or no live price) — never fabricated from a partial calculation.
    const changeUsd0 = depositedAmount0 != null && price0 != null ? netAmount0.minus(depositedAmount0).times(price0).toString() : null;
    const changeUsd1 = depositedAmount1 != null && price1 != null ? netAmount1.minus(depositedAmount1).times(price1).toString() : null;

    return {
      kind: "farm",
      label: meta.name || `Yield Farm #${farmId}`,
      contractAddress,
      farmId,
      multipliers: farmMultipliers(farmer, currentBlock),
      // Farm rewards accrued but not yet minted (collected on ANY withdrawal), and the BOLT staked for
      // the multiplier (returned only when the position is withdrawn in full — verified source).
      pendingRewards,
      hasThirdPartyRewards,
      boltDeposited: ethers.formatUnits(farmer.boltDeposited, 18),
      legs: [
        {
          tokenAddress: meta.token0, symbol: meta0?.symbol || null, amount: amount0.toString(), usdValue: usd0?.toString() ?? null,
          depositedAmount: depositedAmount0?.toString() ?? null, pendingFees: pendingFees0.toString(), netAmount: netAmount0.toString(), changePercent: changePercent0, changeUsd: changeUsd0,
        },
        {
          tokenAddress: meta.token1, symbol: meta1?.symbol || null, amount: amount1.toString(), usdValue: usd1?.toString() ?? null,
          depositedAmount: depositedAmount1?.toString() ?? null, pendingFees: pendingFees1.toString(), netAmount: netAmount1.toString(), changePercent: changePercent1, changeUsd: changeUsd1,
        },
      ],
      // Farm positions are always full-range (isFullRangeFarm above) — see impermanentLoss.js.
      impermanentLoss: computeImpermanentLoss(
        [
          { amount: amount0, pendingFees: pendingFees0, depositedAmount: depositedAmount0, priceUsd: price0 },
          { amount: amount1, pendingFees: pendingFees1, depositedAmount: depositedAmount1, priceUsd: price1 },
        ],
        { fullRange: true }
      ),
      totalUsd: usd0 != null && usd1 != null ? usd0.plus(usd1).toString() : null,
      hasUnpriced: usd0 == null || usd1 == null,
    };
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: failed for farm ${farmId}@${contractAddress}:`, err.message);
    return POSITION_FAILED;
  }
}

/** One farm's CLOSED position cycles — the history counterpart to valueYieldFarmPosition above,
 * for a farm the wallet has fully exited (possibly more than once, if it deposited, withdrew
 * everything, then deposited again later — see getFarmPositionCycles' own comment for why each such
 * cycle is tracked and shown separately rather than blended into one lifetime figure). No live
 * farmer-state read needed (there's nothing currently open to read) — only the farm's static
 * metadata (token0/token1/name, same cached getFarmMeta as the open-position path) and a CURRENT
 * token price, used the same way valueYieldFarmPosition's own changeUsd does: "what this cycle's
 * net token-quantity effect would be worth if priced today," not a historical-at-the-time figure.
 * Returns [] (not null) for a farm with no completed cycles — this is a list, callers don't need to
 * special-case "none". */
async function getClosedFarmCycles(contractAddress, farmId, walletAddress) {
  try {
    const cycles = await getFarmPositionCycles(walletAddress, contractAddress, farmId);
    if (cycles.length === 0) return [];

    const meta = await getFarmMeta(contractAddress, farmId);
    if (!meta) return []; // metadata read failed (logged in getFarmMeta) — can't label/decimal this farm's cycles at all

    const [decimals0, decimals1] = await Promise.all([decimalsFor(meta.token0), decimalsFor(meta.token1)]);
    const [price0, price1] = await Promise.all([getLiveTokenUsdPrice(meta.token0), getLiveTokenUsdPrice(meta.token1)]);
    const [meta0, meta1] = await Promise.all([getTokenMetadata(meta.token0), getTokenMetadata(meta.token1)]);

    function buildLeg(decimals, depositedRaw, withdrawnPrincipalRaw, feesRaw, priceUsd, tokenAddress, symbol) {
      const deposited = new Decimal(ethers.formatUnits(depositedRaw, decimals));
      const withdrawnPrincipal = new Decimal(ethers.formatUnits(withdrawnPrincipalRaw, decimals));
      const fees = new Decimal(ethers.formatUnits(feesRaw, decimals));
      const netAmount = withdrawnPrincipal.plus(fees);
      const changePercent = deposited.gt(0) ? netAmount.minus(deposited).dividedBy(deposited).times(100).toString() : null;
      const changeUsd = priceUsd != null ? netAmount.minus(deposited).times(priceUsd).toString() : null;
      return {
        tokenAddress,
        symbol,
        depositedAmount: deposited.toString(),
        withdrawnAmount: withdrawnPrincipal.toString(),
        pendingFees: fees.toString(), // "pending" naming kept consistent with the open-position shape — these are already-collected here, not still-accruing
        netAmount: netAmount.toString(),
        changePercent,
        changeUsd,
      };
    }

    return cycles.map((c) => {
      const leg0 = buildLeg(decimals0, c.deposited0, c.withdrawnPrincipal0, c.fees0, price0, meta.token0, meta0?.symbol || null);
      const leg1 = buildLeg(decimals1, c.deposited1, c.withdrawnPrincipal1, c.fees1, price1, meta.token1, meta1?.symbol || null);
      const totalChangeUsd = leg0.changeUsd != null && leg1.changeUsd != null ? (Number(leg0.changeUsd) + Number(leg1.changeUsd)).toString() : null;
      return {
        kind: "farm_closed",
        label: meta.name || `Yield Farm #${farmId}`,
        contractAddress,
        farmId,
        startTimestamp: c.startTimestamp,
        endTimestamp: c.endTimestamp,
        legs: [leg0, leg1],
        totalChangeUsd,
        hasUnpriced: price0 == null || price1 == null,
      };
    });
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: failed to build closed cycles for farm ${farmId}@${contractAddress}:`, err.message);
    return [];
  }
}

/** Every closed farm-position cycle across every farm this wallet has ever deposited into — the
 * "Show closed positions" data source. Deliberately no caching layer (unlike getOpenDefiPositionsUsd):
 * this is lazy, user-triggered (a toggle click), not loaded on every page view, and history doesn't
 * change on its own the way a live position's value does, so there's much less to gain from one. */
export async function getClosedFarmPositionsUsd(trackedWallet) {
  const candidates = await getDistinctFarmPositions(trackedWallet);
  if (candidates.length === 0) return { positions: [] };

  const perFarm = await Promise.all(candidates.map((c) => getClosedFarmCycles(c.contractAddress, c.farmId, trackedWallet)));
  const positions = perFarm.flat().sort((a, b) => new Date(b.endTimestamp) - new Date(a.endTimestamp)); // most recently closed first
  return { positions };
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
      // Withdrawing while this is true incurs the contract's early-exit penalty (getUser().currentlyEarly).
      currentlyEarly: Boolean(user.currentlyEarly),
      legs: [{ tokenAddress: coreTokenAddress, symbol: meta?.symbol || null, amount: amount.toString(), usdValue: usdValue?.toString() ?? null }],
      totalUsd: usdValue?.toString() ?? null,
      hasUnpriced: usdValue == null,
    };
  } catch (err) {
    console.warn(`⚠️  DeFi position valuation: failed for staking contract ${contractAddress}:`, err.message);
    return POSITION_FAILED;
  }
}

/**
 * The actual live computation — discovery + on-chain valuation + live pricing, no caching at all.
 * Pure L3: called either synchronously (a wallet's genuinely first-ever computation, nothing cached
 * anywhere yet) or in the background to refresh a stale cache entry (see getOpenDefiPositionsUsd
 * below) — never blocks a caller that already has something usable to show. Returns
 * `{ positions, totalUsd, hasUnpriced, failedCount }`, same shape this file always returned.
 */
async function computeDefiPositionsLive(trackedWallet) {
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
  const failedCount = results.filter((p) => p === POSITION_FAILED).length;
  const positions = results.filter((p) => p != null && p !== POSITION_FAILED);

  let totalUsd = null;
  let hasUnpriced = failedCount > 0; // a position we couldn't value means the total is incomplete
  for (const p of positions) {
    if (p.hasUnpriced) hasUnpriced = true;
    if (p.totalUsd != null) totalUsd = (totalUsd ?? new Decimal(0)).plus(p.totalUsd);
  }

  // Stringified at this boundary (not left as a Decimal instance) so every caller — whether it
  // reads this directly (portfolioValuation.js, via Number()) or relays it through an HTTP JSON
  // response (premiumDashboardRouter.js) — sees the same plain, unambiguous type, matching this
  // codebase's own convention elsewhere (e.g. pnlSnapshotService.js's return shape).
  return { positions, totalUsd: totalUsd?.toString() ?? null, hasUnpriced, failedCount };
}

/** Runs the live computation and writes the result to both cache levels, tagged with the
 * ingestion-freshness signal captured by the CALLER before this ran (see getOpenDefiPositionsUsd's
 * own comment on why the pre-computation timestamp is the correct one to tag with — same reasoning
 * pnlSnapshotService.js's own cache uses). Never throws: a background caller fires this without
 * awaiting it, so a failure here must not become an unhandled rejection. */
async function recomputeAndPersistDefiPositions(trackedWallet, ingestionUpdatedAtMs) {
  const cacheKey = trackedWallet.toLowerCase();
  try {
    const result = await computeDefiPositionsLive(trackedWallet);
    setBounded(positionsCache, cacheKey, { result, computedAt: Date.now(), ingestionUpdatedAt: ingestionUpdatedAtMs }, POSITIONS_CACHE_MAX_ENTRIES);
    await upsertCachedPosition(trackedWallet, "defi", result, String(ingestionUpdatedAtMs)).catch((err) =>
      console.warn(`⚠️  DeFi position valuation: failed to persist cache for ${trackedWallet}:`, err.message)
    );
    return result;
  } catch (err) {
    console.error(`⚠️  DeFi position valuation: live recompute failed for ${trackedWallet}:`, err.message);
    return null;
  }
}

/**
 * Every currently-OPEN farm/staking position for `trackedWallet`, with a live USD value each — the
 * missing piece behind Combined Holdings / Total Portfolio Balance not reflecting staked/farmed
 * funds (see this file's own header comment). Returns `{ positions, totalUsd, hasUnpriced,
 * failedCount, refreshing? }` — `positions` is `[]` (not an error) for a wallet with no DeFi
 * activity at all, or none still open. `failedCount` is how many open-or-unknown positions couldn't
 * be valued this call (already reflected in `hasUnpriced`). `totalUsd` is a Decimal (or null if
 * every open position is unpriced) — sum of only the priced positions/legs, following this app's own
 * "omit rather than fake" convention throughout; a member whose 3 farm legs are only 2/3 priced
 * still sees SOMETHING here, flagged incomplete via `hasUnpriced`, not a blank stretch. `refreshing:
 * true` means the returned figures are a real, cached value that's now known to be stale (something
 * new was ingested since it was computed) — a background recompute is already in flight and the
 * caller should poll again shortly for the fresh one, same "keep showing something real while it
 * catches up" spirit as the ingest-job progress banner, just for a value that's already known rather
 * than one that's never been computed at all.
 */
export async function getOpenDefiPositionsUsd(trackedWallet) {
  const cacheKey = trackedWallet.toLowerCase();
  // Read ingestion state up front, same as pnlSnapshotService.js's own cache does, so whichever
  // cache level ends up writing a fresh entry tags it with this PRE-computation timestamp: if
  // ensureDefiActivityIngested (inside computeDefiPositionsLive) finds something genuinely new, the
  // very next call's own fresh getIngestionState read sees a newer updated_at and correctly misses
  // both cache levels instead of serving a result computed before that new data existed.
  const ingestionState = await getIngestionState(trackedWallet).catch(() => null);
  const ingestionUpdatedAtMs = ingestionState?.updated_at ? new Date(ingestionState.updated_at).getTime() : null;
  const ingestionFingerprint = String(ingestionUpdatedAtMs);

  // L1 — in-memory, exact freshness match required (no `refreshing` path here: within one backend
  // process's own TTL window, just recompute synchronously same as always rather than adding
  // background-refresh complexity for a cache level that resets every restart anyway).
  const l1 = positionsCache.get(cacheKey);
  if (l1 && l1.ingestionUpdatedAt === ingestionUpdatedAtMs && Date.now() - l1.computedAt < POSITIONS_CACHE_TTL_MS) {
    return l1.result;
  }

  // L2 — persisted in Supabase, survives restarts. This is what makes the FIRST request after a
  // deploy (or the first Core Tier load of the day) instant instead of paying the full live-compute
  // cost, which L1 alone can never do.
  const persisted = await getCachedPosition(trackedWallet, "defi").catch(() => null);
  if (persisted) {
    // Populate L1 either way — even a stale L2 row is worth remembering for THIS process's own
    // in-memory hits until the background refresh below lands a fresher one.
    setBounded(positionsCache, cacheKey, { result: persisted.payload, computedAt: Date.now(), ingestionUpdatedAt: Number(persisted.fingerprint) || null }, POSITIONS_CACHE_MAX_ENTRIES);

    if (persisted.fingerprint === ingestionFingerprint) {
      // Nothing's been ingested since this was computed — the payload's quantities are still exactly
      // correct, not just "last known". Serve it as a genuine hit, no refresh needed.
      return persisted.payload;
    }

    // Stale: something real happened on-chain since this was computed. Still real numbers, still
    // close (only the QUANTITIES could be wrong, and only for whatever specifically changed) — serve
    // immediately, and kick exactly one background recompute per wallet (inFlightRefresh dedupes
    // concurrent callers) so the next read gets the fresh figure.
    if (!inFlightRefresh.has(cacheKey)) {
      const promise = recomputeAndPersistDefiPositions(trackedWallet, ingestionUpdatedAtMs).finally(() => inFlightRefresh.delete(cacheKey));
      inFlightRefresh.set(cacheKey, promise);
    }
    return { ...persisted.payload, refreshing: true };
  }

  // L3 — nothing cached anywhere for this wallet yet (genuinely first time). No shortcut available;
  // this is the one case that's unavoidably as slow as it's always been, and the caller (see
  // premiumDashboardRouter.js's checkAndStartDefiIngestIfNeeded) already has a progress banner for
  // exactly this situation.
  const result = await computeDefiPositionsLive(trackedWallet);
  setBounded(positionsCache, cacheKey, { result, computedAt: Date.now(), ingestionUpdatedAt: ingestionUpdatedAtMs }, POSITIONS_CACHE_MAX_ENTRIES);
  await upsertCachedPosition(trackedWallet, "defi", result, ingestionFingerprint).catch((err) =>
    console.warn(`⚠️  DeFi position valuation: failed to persist cache for ${trackedWallet}:`, err.message)
  );
  return result;
}
