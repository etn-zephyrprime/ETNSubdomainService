// backend/services/scenarioRewards.js
//
// Core Tier Scenarios — Tool 2 (yield farm "add more / withdraw now") and Tool 4 (reward
// projections for ElectroSwap yield farms and Core Ascension staking). Read-only.
//
// Everything here follows the verified contract source, not documentation (see
// etnsubdomain-scenario-suite-research in project notes for the full write-up):
//
// YieldFarm 0xe653…bc82
//   - Reward token (DYNO) per block for a farm = rewardPerBlock x allocPoint / totalAllocPoint, split
//     by liquidity share. The amount PAID when collected = accrued x boltMultiplier x
//     durationMultiplier / 1e8, both multipliers taken AT COLLECTION TIME — so waiting raises the
//     multiplier on everything uncollected, and a top-up (which doesn't collect) lowers it.
//   - Duration multiplier = 10000 + 15000 x blocksServed / 6,307,200, capped at 25000 (1.0x -> 2.5x).
//   - Top-up: startingBlock = now - blocksServed x (1 - added/(old+added)).
//   - Partner reward (ThirdPartyReward, e.g. CLUB on farm 6): tokensPerBlock until endBlock, by
//     share, NO multipliers.
//   - Withdraw: no fee, no lock; collects all pending rewards and fees. Staked BOLT returns only on
//     a full withdrawal.
// CoreAscensionV2 0x200a…1cd6
//   - CORE per block = rewardPerBlock (admin-funded, until endBlock) x weight / totalRewardWeight,
//     weight = coreStaked x NFT boost (1 NFT 1.0x, 2 1.1x, 3 1.2x, 4 1.3x); at least 1 NFT required.
//   - MAX_CORE_STAKE 10,000 per user. Withdrawing within 60 days of the LAST stake costs 15% (every
//     stakeCore() resets the clock).
//
// Projections hold today's emission rate, total stake and prices constant — and show how the result
// moves if total stake or the reward token's price changes (sensitivity), never one big number.
import Decimal from "decimal.js";
import { ethers } from "ethers";
import { getOpenDefiPositionsUsd } from "./defiPositionValuation.js";
import { getTokenMetadata } from "./pnlIngestion.js";
import { quoteSell } from "./whatIfSimulator.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { NATIVE_SENTINEL, canonicalTokenKey } from "./pnlEventBuilder.js";

export const YIELD_FARM_ADDRESS = "0xe653ac16b732876f58a1722d24801230fa96bc82";
export const CORE_ASCENSION_ADDRESS = "0x200a9b5fe78d4cb5232a3a0c52b510f961c51cd6";
const CORE_TOKEN = "0x309b916b3a90cb3e071697ea9680e9217a30066f";

export const MAX_BLOCKS_FOR_BONUS = 6307200;
export const BLOCKS_PER_DAY = MAX_BLOCKS_FOR_BONUS / 365; // the contracts size a year as 6,307,200 blocks (5s)
const CALC_PRECISION = 10n ** 18n;
const Q96 = 2n ** 96n;
export const MULTIPLIER_MILESTONES = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
export const NFT_BOOST = { 1: 1.0, 2: 1.1, 3: 1.2, 4: 1.3 };
export const MAX_CORE_STAKE = 10000;
export const EARLY_EXIT_DAYS = 60;
export const EARLY_EXIT_PENALTY = 0.15;
export const HORIZON_DAYS = [30, 90, 365];
export const SENSITIVITY = { totalStake: [0.5, 1, 2], rewardPrice: [-50, 0, 50] };

const FARM_ABI = [
  "function getFarmById(uint256) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))",
  "function getFarmerByFarmIdAndAddress(uint256, address) view returns (tuple(address addr, uint256 liquidity, uint256 boltMultiplier, uint256 boltDeposited, uint256 durationMultiplier, uint256 startingBlock, uint256 rewards, uint256 rewardDebt, uint256 thirdPartyRewards, uint256 thirdPartyRewardDebt, uint256 fees0, uint256 fees0Debt, uint256 fees1, uint256 fees1Debt))",
  "function rewardPerBlock() view returns (uint256)",
  "function totalAllocPoint() view returns (uint256)",
  "function rewardToken() view returns (address)",
  "function getThirdPartyRewardConfigByFarmId(uint256) view returns (tuple(address token, address tokenManager, uint256 tokensPerBlock, uint256 endBlock))",
];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const STAKING_ABI = [
  "function rewardPerBlock() view returns (uint256)",
  "function endBlock() view returns (uint256)",
  "function totalRewardWeight() view returns (uint256)",
  "function totalCoreStaked() view returns (uint256)",
  "function getUser(address account) view returns (uint256 coreStaked, uint256 nftCount, uint256 rewardWeight, uint256 entryTime, uint256 pendingRewards, bool currentlyEarly, uint256 boostBps)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

let provider = null;
const getProvider = () => (provider ||= createRpcProvider());

export class RewardsInputError extends Error {}

// ---- Pure contract maths ---------------------------------------------------------------------

/** YieldFarm _calculateDurationMultiplier, as a plain multiplier (1.0 - 2.5). */
export function durationMultiplier(blocksServed) {
  const b = Math.max(0, blocksServed);
  if (b >= MAX_BLOCKS_FOR_BONUS) return 2.5;
  return (10000 + Math.floor((15000 * b) / MAX_BLOCKS_FOR_BONUS)) / 10000;
}

/** Blocks served after a top-up: the contract's dilution of startingBlock. */
export function blocksServedAfterTopUp(blocksServed, oldLiquidity, addedLiquidity) {
  const total = oldLiquidity + addedLiquidity;
  if (total <= 0) return 0;
  return blocksServed - (blocksServed * addedLiquidity) / total;
}

/**
 * Farm reward projection for one farmer, `horizonBlocks` ahead, collecting at the end (multipliers
 * at THAT moment). `othersScale` scales everyone else's liquidity (sensitivity: "if total staked
 * doubles"). Rates in reward tokens per block. Returns { rewardTokens, partnerTokens, multiplierAt }.
 */
export function projectFarmRewards({ farmLiquidity, farmerLiquidity, farmRewardPerBlock, pendingBase = 0, blocksServed, boltMultiplier, horizonBlocks, othersScale = 1, partnerPerBlock = 0, partnerBlocksLeft = Infinity, pendingPartner = 0 }) {
  const others = Math.max(0, farmLiquidity - farmerLiquidity);
  const total = farmerLiquidity + others * othersScale;
  const share = total > 0 ? farmerLiquidity / total : 0;
  const accruedBase = pendingBase + farmRewardPerBlock * share * horizonBlocks;
  const mult = durationMultiplier(blocksServed + horizonBlocks);
  return {
    share,
    multiplierAt: mult,
    rewardTokens: accruedBase * boltMultiplier * mult,
    partnerTokens: pendingPartner + partnerPerBlock * share * Math.min(horizonBlocks, partnerBlocksLeft),
  };
}

/** Core Ascension projection: CORE earned over `horizonBlocks` (capped at the funded endBlock). */
export function projectStakingRewards({ rewardPerBlock, blocksLeftFunded, weight, totalWeight, horizonBlocks, othersScale = 1, pending = 0 }) {
  const others = Math.max(0, totalWeight - weight);
  const total = weight + others * othersScale;
  const share = total > 0 ? weight / total : 0;
  return { share, coreTokens: pending + rewardPerBlock * share * Math.min(horizonBlocks, Math.max(0, blocksLeftFunded)) };
}

// ---- Reading live state ----------------------------------------------------------------------

async function etnPriceOf(token) {
  if (token === NATIVE_SENTINEL) return new Decimal(1);
  const p = await getTokenEtnPrice(getProvider(), token).catch(() => null);
  return p != null && p > 0 ? new Decimal(p) : null;
}

async function symbolOf(token) {
  if (token === NATIVE_SENTINEL) return "ETN";
  return (await getTokenMetadata(token).catch(() => null))?.symbol || `${token.slice(0, 6)}…`;
}

/** Live state of one farm and (optionally) one farmer in it, in human units. */
async function readFarm(farmId, wallet) {
  const farmC = new ethers.Contract(YIELD_FARM_ADDRESS, FARM_ABI, getProvider());
  const [farm, farmer, rewardPerBlock, totalAlloc, rewardToken, tp, block] = await Promise.all([
    farmC.getFarmById(farmId),
    wallet ? farmC.getFarmerByFarmIdAndAddress(farmId, wallet) : null,
    farmC.rewardPerBlock(),
    farmC.totalAllocPoint(),
    farmC.rewardToken(),
    farmC.getThirdPartyRewardConfigByFarmId(farmId).catch(() => null),
    getProvider().getBlockNumber(),
  ]);
  if (!farm || farm.id === 0n) throw new RewardsInputError("That farm doesn't exist");
  const slot0 = await new ethers.Contract(farm.poolAddr, POOL_ABI, getProvider()).slot0();
  const [d0, d1] = await Promise.all([farm.token0, farm.token1].map((t) => new ethers.Contract(t, ERC20_ABI, getProvider()).decimals().then(Number)));
  const t0 = canonicalTokenKey(farm.token0.toLowerCase());
  const t1 = canonicalTokenKey(farm.token1.toLowerCase());
  const [p0, p1] = await Promise.all([etnPriceOf(t0), etnPriceOf(t1)]);
  // Whole farm's position value (full range): amount0 = L x Q96 / sqrtP, amount1 = L x sqrtP / Q96.
  const amt0 = new Decimal(ethers.formatUnits((farm.liquidity * Q96) / slot0.sqrtPriceX96, d0));
  const amt1 = new Decimal(ethers.formatUnits((farm.liquidity * slot0.sqrtPriceX96) / Q96, d1));
  const farmValueEtn = p0 && p1 ? amt0.times(p0).plus(amt1.times(p1)) : null;

  // Bring the reward accumulator to the current block (contract's _updateFarmRewardsAndFees).
  const farmRewardRaw = totalAlloc > 0n ? (rewardPerBlock * farm.allocPoint) / totalAlloc : 0n;
  let acc = farm.accRewardsPerShare;
  if (farm.liquidity > 0n && farm.active && BigInt(block) > farm.lastCalcBlock) acc += ((BigInt(block) - farm.lastCalcBlock) * farmRewardRaw * CALC_PRECISION) / farm.liquidity;
  let pendingBaseRaw = 0n;
  let pendingPartnerRaw = 0n;
  const partnerActive = tp && tp.token !== ethers.ZeroAddress;
  if (farmer && farmer.liquidity > 0n) {
    pendingBaseRaw = (farmer.liquidity * acc) / CALC_PRECISION - farmer.rewardDebt;
    if (pendingBaseRaw < 0n) pendingBaseRaw = 0n;
    if (partnerActive) {
      let accTp = farm.accThirdPartyRewardsPerShare;
      const until = BigInt(block) < tp.endBlock ? BigInt(block) : tp.endBlock;
      if (farm.liquidity > 0n && farm.active && tp.tokensPerBlock > 0n && until > farm.lastCalcBlock) accTp += ((until - farm.lastCalcBlock) * tp.tokensPerBlock * CALC_PRECISION) / farm.liquidity;
      pendingPartnerRaw = (farmer.liquidity * accTp) / CALC_PRECISION - farmer.thirdPartyRewardDebt;
      if (pendingPartnerRaw < 0n) pendingPartnerRaw = 0n;
    }
  }
  const rewardDec = await new ethers.Contract(rewardToken, ERC20_ABI, getProvider()).decimals().then(Number);
  const partnerDec = partnerActive ? await new ethers.Contract(tp.token, ERC20_ABI, getProvider()).decimals().then(Number) : 18;
  return {
    farmId: Number(farmId),
    name: farm.name,
    active: farm.active,
    tokens: [t0, t1],
    currentBlock: block,
    farmLiquidity: Number(farm.liquidity),
    farmValueEtn,
    farmRewardPerBlock: Number(ethers.formatUnits(farmRewardRaw, rewardDec)),
    rewardToken: canonicalTokenKey(rewardToken.toLowerCase()),
    partner: partnerActive
      ? { token: canonicalTokenKey(tp.token.toLowerCase()), perBlock: Number(ethers.formatUnits(tp.tokensPerBlock, partnerDec)), blocksLeft: Math.max(0, Number(tp.endBlock) - block) }
      : null,
    farmer:
      farmer && farmer.liquidity > 0n
        ? {
            liquidity: Number(farmer.liquidity),
            blocksServed: block - Number(farmer.startingBlock),
            boltMultiplier: Number(farmer.boltMultiplier) / 10000 || 1,
            boltDeposited: Number(ethers.formatUnits(farmer.boltDeposited, 18)),
            pendingBase: Number(ethers.formatUnits(pendingBaseRaw, rewardDec)),
            pendingPartner: Number(ethers.formatUnits(pendingPartnerRaw, partnerDec)),
          }
        : null,
  };
}

async function readStaking(wallet) {
  const c = new ethers.Contract(CORE_ASCENSION_ADDRESS, STAKING_ABI, getProvider());
  const [rewardPerBlock, endBlock, totalWeight, totalStaked, user, block] = await Promise.all([
    c.rewardPerBlock(),
    c.endBlock(),
    c.totalRewardWeight(),
    c.totalCoreStaked(),
    wallet ? c.getUser(wallet) : null,
    getProvider().getBlockNumber(),
  ]);
  const f = (v) => Number(ethers.formatUnits(v, 18));
  return {
    currentBlock: block,
    rewardPerBlock: f(rewardPerBlock),
    blocksLeftFunded: Math.max(0, Number(endBlock) - block),
    endBlock: Number(endBlock),
    totalWeight: f(totalWeight),
    totalStaked: f(totalStaked),
    user: user
      ? {
          coreStaked: f(user.coreStaked),
          nftCount: Number(user.nftCount),
          weight: f(user.rewardWeight),
          entryTime: Number(user.entryTime),
          pending: f(user.pendingRewards),
          currentlyEarly: Boolean(user.currentlyEarly),
        }
      : null,
  };
}

/** Values `amount` of `token` at spot and, if `sell`, as actually sold into the best pool. */
async function valueReward(token, amount, etnUsd, sell = true) {
  const price = await etnPriceOf(token);
  const spotEtn = price ? new Decimal(amount).times(price) : null;
  let soldEtn = null;
  let impactPct = null;
  if (sell && amount > 0 && token !== NATIVE_SENTINEL && spotEtn) {
    try {
      const { quote } = await quoteSell(token, new Decimal(amount));
      soldEtn = quote.etnOut;
      impactPct = quote.priceImpactPct;
    } catch {
      soldEtn = null;
    }
  }
  return {
    spotEtn: spotEtn?.toString() ?? null,
    spotUsd: spotEtn ? spotEtn.times(etnUsd).toString() : null,
    soldEtn: soldEtn?.toString() ?? null,
    soldUsd: soldEtn ? soldEtn.times(etnUsd).toString() : null,
    impactPct: impactPct?.toString() ?? null,
  };
}

const daysToBlocks = (d) => Math.round(d * BLOCKS_PER_DAY);

/** Rewards over each horizon for one farmer state (real or hypothetical), with the sensitivity grid. */
async function farmProjection(state, farmer, etnUsd, extraHorizons = []) {
  const horizons = [...HORIZON_DAYS.map((d) => ({ label: `${d} days`, days: d })), ...extraHorizons];
  const rewardSym = await symbolOf(state.rewardToken);
  const partnerSym = state.partner ? await symbolOf(state.partner.token) : null;
  const rewardPrice = await etnPriceOf(state.rewardToken);
  const partnerPrice = state.partner ? await etnPriceOf(state.partner.token) : null;
  const out = [];
  for (const h of horizons) {
    const blocks = daysToBlocks(h.days);
    const run = (othersScale) =>
      projectFarmRewards({
        farmLiquidity: state.farmLiquidity + (farmer.added || 0),
        farmerLiquidity: farmer.liquidity,
        farmRewardPerBlock: state.active ? state.farmRewardPerBlock : 0,
        pendingBase: farmer.pendingBase || 0,
        blocksServed: farmer.blocksServed,
        boltMultiplier: farmer.boltMultiplier,
        horizonBlocks: blocks,
        othersScale,
        partnerPerBlock: state.partner?.perBlock || 0,
        partnerBlocksLeft: state.partner?.blocksLeft ?? 0,
        pendingPartner: farmer.pendingPartner || 0,
      });
    const base = run(1);
    // Sensitivity: every combination of total stake x reward-token price, valued at spot.
    const values = [];
    for (const scale of SENSITIVITY.totalStake) {
      const r = run(scale);
      for (const pricePct of SENSITIVITY.rewardPrice) {
        const m = 1 + pricePct / 100;
        const etn = (rewardPrice ? r.rewardTokens * rewardPrice.toNumber() * m : 0) + (partnerPrice ? r.partnerTokens * partnerPrice.toNumber() * m : 0);
        values.push(etn);
      }
    }
    const reward = await valueReward(state.rewardToken, base.rewardTokens, etnUsd);
    const partner = state.partner ? await valueReward(state.partner.token, base.partnerTokens, etnUsd) : null;
    out.push({
      label: h.label,
      days: h.days,
      multiplierAt: base.multiplierAt,
      share: base.share,
      rewardTokens: base.rewardTokens,
      rewardSymbol: rewardSym,
      reward,
      partnerTokens: state.partner ? base.partnerTokens : null,
      partnerSymbol: partnerSym,
      partner,
      rangeEtn: { low: Math.min(...values), high: Math.max(...values) },
      rangeUsd: { low: Math.min(...values) * etnUsd.toNumber(), high: Math.max(...values) * etnUsd.toNumber() },
    });
  }
  return out;
}

function nextMilestone(blocksServed) {
  const now = durationMultiplier(blocksServed);
  const next = MULTIPLIER_MILESTONES.find((m) => m > now + 1e-9);
  if (!next) return null;
  const blocksNeeded = Math.ceil(((next * 10000 - 10000) / 15000) * MAX_BLOCKS_FOR_BONUS) - blocksServed;
  return { multiplier: next, blocks: blocksNeeded, days: blocksNeeded / BLOCKS_PER_DAY };
}

async function etnUsdNow() {
  const c = await getEtnPriceCache();
  if (c?.usd == null) throw new Error("ETN/USD price isn't available right now — try again shortly");
  return new Decimal(c.usd);
}

function farmIdFromKey(key) {
  const m = /^farm:0xe653ac16b732876f58a1722d24801230fa96bc82:(\d+)$/i.exec(String(key));
  if (!m) throw new RewardsInputError("Pick one of the ElectroSwap yield farms");
  return Number(m[1]);
}

// ---- Tool 2: farm add more / withdraw now ----------------------------------------------------

/**
 * `action: "add"` — what depositing `addUsd` more does: blended duration multiplier (the contract's
 * dilution), how long until it recovers, change in reward share and rate, and the hit to pending
 * rewards if they aren't claimed first. `action: "withdraw"` — what's lost by leaving now (multiplier
 * accrued on the withdrawn part) vs waiting for the next multiplier milestone, under the sensitivity
 * grid; the exit itself (what comes back, P&L) is the Sell / exit tool's position exit.
 */
export async function runFarmScenario(walletAddress, { farmKey, action, addUsd, withdrawPct }) {
  const wallet = walletAddress.toLowerCase();
  const farmId = farmIdFromKey(farmKey);
  const etnUsd = await etnUsdNow();
  const state = await readFarm(farmId, wallet);
  if (!state.farmer) throw new RewardsInputError("This wallet has no position in that farm");
  const defi = await getOpenDefiPositionsUsd(wallet).catch(() => null);
  const pos = (defi?.positions || []).find((p) => p.kind === "farm" && Number(p.farmId) === farmId);
  const f = state.farmer;
  // Position value from the farm's own on-chain state (share of its liquidity x the pool's value at
  // current prices) — the same basis the top-up is sized on, independent of any cached valuation.
  const positionUsd = state.farmValueEtn ? state.farmValueEtn.times(f.liquidity / state.farmLiquidity).times(etnUsd) : pos?.totalUsd != null ? new Decimal(pos.totalUsd) : null;
  const multNow = durationMultiplier(f.blocksServed);
  const rewardSym = await symbolOf(state.rewardToken);
  const rewardPrice = await etnPriceOf(state.rewardToken);
  const pendingPaidNow = f.pendingBase * f.boltMultiplier * multNow;

  const common = {
    farm: { id: farmId, name: state.name, active: state.active, tokens: await Promise.all(state.tokens.map(symbolOf)) },
    position: { valueUsd: positionUsd?.toString() ?? null, multiplier: multNow, boltMultiplier: f.boltMultiplier, boltDeposited: f.boltDeposited, impermanentLoss: pos?.impermanentLoss ?? null },
    pending: { rewardTokens: pendingPaidNow, rewardSymbol: rewardSym, partnerTokens: state.partner ? f.pendingPartner : null, partnerSymbol: state.partner ? await symbolOf(state.partner.token) : null },
    etnUsd: etnUsd.toString(),
  };
  const assumptions = {
    pricedAt: new Date().toISOString(),
    etnUsd: etnUsd.toString(),
    emission: `${rewardSym} per block for this farm: ${state.farmRewardPerBlock.toPrecision(4)} (rewardPerBlock x allocPoint / totalAllocPoint, read live)${state.active ? "" : " — the farm is inactive, so it earns nothing"}.`,
    partner: state.partner ? `Partner reward: ${common.pending.partnerSymbol} ${state.partner.perBlock.toPrecision(4)} per block for ${Math.round(state.partner.blocksLeft / BLOCKS_PER_DAY)} more days, by share, with no multipliers.` : null,
    multipliers: "Duration multiplier 1.0x -> 2.5x over ~1 year; it and your BOLT multiplier are applied when rewards are collected (any deposit or withdraw collects, except a top-up).",
    constant: "Held constant: today's emission rate, everyone else's stake and today's prices. The range shows total stake x0.5 to x2 and reward price -50% to +50%.",
    blocks: "A day = 17,280 blocks (the contract's own 5-second sizing).",
  };

  if (action === "add") {
    const add = Number(addUsd);
    if (!Number.isFinite(add) || add <= 0) throw new RewardsInputError("Enter how much you'd add, in USD");
    if (!positionUsd || positionUsd.lte(0)) throw new RewardsInputError("This position has no live value to size a top-up against");
    // Liquidity added in proportion to value (both tokens at the current pool ratio, full range).
    const addedLiquidity = f.liquidity * (add / positionUsd.toNumber());
    const servedAfter = blocksServedAfterTopUp(f.blocksServed, f.liquidity, addedLiquidity);
    const multAfter = durationMultiplier(servedAfter);
    const recoverDays = (f.blocksServed - servedAfter) / BLOCKS_PER_DAY;
    const shareBefore = f.liquidity / state.farmLiquidity;
    const shareAfter = (f.liquidity + addedLiquidity) / (state.farmLiquidity + addedLiquidity);
    const ratePerDay = (share, mult) => state.farmRewardPerBlock * share * BLOCKS_PER_DAY * f.boltMultiplier * mult;
    // Pending rewards are NOT collected on a top-up, so they're paid later at the lower multiplier.
    const pendingLost = f.pendingBase * f.boltMultiplier * (multNow - multAfter);
    const after = { ...f, liquidity: f.liquidity + addedLiquidity, blocksServed: servedAfter, added: addedLiquidity };
    return {
      action: "add",
      ...common,
      add: {
        usd: add,
        multiplierAfter: multAfter,
        recoverDays,
        shareBefore,
        shareAfter,
        rewardPerDayBefore: ratePerDay(shareBefore, multNow),
        rewardPerDayAfter: ratePerDay(shareAfter, multAfter),
        pendingLostIfNotClaimed: pendingLost,
        pendingLostEtn: rewardPrice ? pendingLost * rewardPrice.toNumber() : null,
      },
      projectionBefore: await farmProjection(state, f, etnUsd),
      projectionAfter: await farmProjection(state, after, etnUsd),
      costBasisNote: "Depositing moves your tokens into the farm as a lot transfer, so their cost basis carries over; adding liquidity first doesn't create a gain or loss either.",
      assumptions,
    };
  }

  if (action === "withdraw") {
    const pct = Number(withdrawPct ?? 100);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new RewardsInputError("Withdraw percentage must be between 0 and 100");
    const milestone = nextMilestone(f.blocksServed);
    const waitHorizons = milestone ? [{ label: `until ${milestone.multiplier.toFixed(2)}x`, days: milestone.days }] : [];
    const projection = await farmProjection(state, f, etnUsd, waitHorizons);
    const waitRow = milestone ? projection[projection.length - 1] : null;
    const pendingNowValue = await valueReward(state.rewardToken, pendingPaidNow, etnUsd);
    return {
      action: "withdraw",
      ...common,
      withdraw: {
        pct,
        full: pct === 100,
        paidNow: { rewardTokens: pendingPaidNow, value: pendingNowValue, partnerTokens: common.pending.partnerTokens },
        multiplierLost: pct === 100 ? multNow : null,
        boltReturned: pct === 100 ? f.boltDeposited : 0,
        nextMilestone: milestone,
        waitGainTokens: waitRow ? waitRow.rewardTokens - pendingPaidNow : null,
        waitGain: waitRow,
      },
      projection,
      exposure: "Staying in keeps your tokens in the pool: their value keeps moving with both prices, and impermanent loss can grow or shrink. Use the Stress test to see how a price move would affect it.",
      assumptions,
    };
  }
  throw new RewardsInputError("action must be add or withdraw");
}

// ---- Tool 4: reward projections ----------------------------------------------------------------

/**
 * Projects rewards for `target`: "farm:<contract>:<id>" or "staking". `deposit` (optional) is a
 * hypothetical extra: { usd } for a farm, { core, nfts } for staking — otherwise the wallet's
 * current position. Horizons 30 / 90 / 365 days (+ the 60-day mark for staking), each with a range.
 */
export async function runRewardProjection(walletAddress, { target, deposit = null }) {
  const wallet = walletAddress.toLowerCase();
  const etnUsd = await etnUsdNow();

  if (target === "staking") {
    const s = await readStaking(wallet);
    const u = s.user || { coreStaked: 0, nftCount: 0, weight: 0, pending: 0, entryTime: 0, currentlyEarly: false };
    const addCore = deposit?.core != null ? Number(deposit.core) : 0;
    if (!Number.isFinite(addCore) || addCore < 0) throw new RewardsInputError("Enter a CORE amount of 0 or more");
    if (u.coreStaked <= 0 && addCore <= 0) throw new RewardsInputError("This wallet has no Core Ascension stake — enter a CORE amount and NFT count to project one");
    const nfts = deposit?.nfts != null ? Number(deposit.nfts) : u.nftCount;
    if (![1, 2, 3, 4].includes(nfts)) throw new RewardsInputError("Core Ascension needs between 1 and 4 eligible NFTs staked");
    const core = u.coreStaked + addCore;
    if (core <= 0) throw new RewardsInputError("Enter how much CORE you'd stake");
    const warnings = [];
    if (core > MAX_CORE_STAKE) warnings.push(`The contract caps each wallet at ${MAX_CORE_STAKE.toLocaleString()} CORE staked; this would be ${core.toLocaleString()}.`);
    if (addCore > 0 && u.coreStaked > 0) warnings.push("Staking more restarts the 60-day early-exit clock on your whole stake.");
    const weight = core * NFT_BOOST[nfts];
    const totalWeight = s.totalWeight - u.weight + weight;
    const corePrice = await etnPriceOf(CORE_TOKEN);
    const horizons = [...HORIZON_DAYS.map((d) => ({ label: `${d} days`, days: d })), { label: "60 days (early-exit mark)", days: EARLY_EXIT_DAYS }].sort((a, b) => a.days - b.days);
    const rows = [];
    for (const h of horizons) {
      const blocks = daysToBlocks(h.days);
      const run = (scale) => projectStakingRewards({ rewardPerBlock: s.rewardPerBlock, blocksLeftFunded: s.blocksLeftFunded, weight, totalWeight, horizonBlocks: blocks, othersScale: scale, pending: u.pending });
      const base = run(1);
      const values = [];
      for (const scale of SENSITIVITY.totalStake) for (const pricePct of SENSITIVITY.rewardPrice) values.push(corePrice ? run(scale).coreTokens * corePrice.toNumber() * (1 + pricePct / 100) : 0);
      rows.push({
        label: h.label,
        days: h.days,
        share: base.share,
        rewardTokens: base.coreTokens,
        rewardSymbol: "CORE",
        reward: await valueReward(CORE_TOKEN, base.coreTokens, etnUsd),
        rangeEtn: { low: Math.min(...values), high: Math.max(...values) },
        rangeUsd: { low: Math.min(...values) * etnUsd.toNumber(), high: Math.max(...values) * etnUsd.toNumber() },
      });
    }
    const earlyDaysLeft = u.entryTime ? Math.max(0, (u.entryTime + EARLY_EXIT_DAYS * 86400 - Date.now() / 1000) / 86400) : null;
    return {
      target: "staking",
      label: "Core Ascension Staking",
      stake: { core, addCore, nfts, boost: NFT_BOOST[nfts], weight, currentCore: u.coreStaked, currentNfts: u.nftCount },
      earlyExit: {
        penaltyPct: EARLY_EXIT_PENALTY * 100,
        daysLeft: addCore > 0 ? EARLY_EXIT_DAYS : earlyDaysLeft,
        penaltyCore: (addCore > 0 || u.currentlyEarly) ? core * EARLY_EXIT_PENALTY : 0,
      },
      projection: rows,
      warnings,
      assumptions: {
        pricedAt: new Date().toISOString(),
        etnUsd: etnUsd.toString(),
        emission: `${s.rewardPerBlock.toPrecision(4)} CORE per block, funded until block ${s.endBlock.toLocaleString()} (about ${Math.round(s.blocksLeftFunded / BLOCKS_PER_DAY)} more days) — nothing is paid past that unless it's topped up.`,
        weight: `Your share = CORE staked x NFT boost (1 NFT 1.0x, 2 1.1x, 3 1.2x, 4 1.3x) ÷ everyone's total (${s.totalWeight.toLocaleString(undefined, { maximumFractionDigits: 0 })} now).`,
        earlyExit: "Withdrawing within 60 days of your last stake costs 15% of the amount withdrawn (2/3 back to the reward pool, 1/3 burned).",
        constant: "Held constant: today's emission rate, everyone else's stake and today's CORE price. The range shows total stake x0.5 to x2 and CORE price -50% to +50%.",
        sale: "\"If sold\" is CORE sold to ETN at the best ElectroSwap pool now, after price impact and CORE's own sell tax.",
      },
    };
  }

  const farmId = farmIdFromKey(target);
  const state = await readFarm(farmId, wallet);
  let farmer = state.farmer;
  const warnings = [];
  if (!state.active) warnings.push("This farm is inactive: it isn't paying rewards.");
  if (deposit?.usd != null) {
    const add = Number(deposit.usd);
    if (!Number.isFinite(add) || add <= 0) throw new RewardsInputError("Enter how much you'd deposit, in USD");
    if (!state.farmValueEtn || state.farmValueEtn.lte(0)) throw new RewardsInputError("This farm has no priced liquidity to size a deposit against");
    const addedLiquidity = state.farmLiquidity * (add / state.farmValueEtn.times(etnUsd).toNumber());
    if (farmer) {
      warnings.push("A top-up dilutes your duration multiplier — see the Farm tool for the exact effect.");
      farmer = { ...farmer, liquidity: farmer.liquidity + addedLiquidity, blocksServed: blocksServedAfterTopUp(farmer.blocksServed, farmer.liquidity, addedLiquidity), added: addedLiquidity };
    } else {
      farmer = { liquidity: addedLiquidity, blocksServed: 0, boltMultiplier: 1, pendingBase: 0, pendingPartner: 0, added: addedLiquidity };
    }
  }
  if (!farmer) throw new RewardsInputError("This wallet has no position in that farm — enter a deposit amount to project one");
  const defi = await getOpenDefiPositionsUsd(wallet).catch(() => null);
  const pos = (defi?.positions || []).find((p) => p.kind === "farm" && Number(p.farmId) === farmId);
  return {
    target,
    label: state.name,
    farm: { id: farmId, active: state.active, tokens: await Promise.all(state.tokens.map(symbolOf)), valueUsd: state.farmValueEtn ? state.farmValueEtn.times(etnUsd).toString() : null },
    hypothetical: deposit?.usd != null,
    multiplierNow: durationMultiplier(farmer.blocksServed),
    boltMultiplier: farmer.boltMultiplier,
    impermanentLoss: deposit?.usd == null ? pos?.impermanentLoss ?? null : null,
    projection: await farmProjection(state, farmer, etnUsd),
    warnings,
    assumptions: {
      pricedAt: new Date().toISOString(),
      etnUsd: etnUsd.toString(),
      emission: `${await symbolOf(state.rewardToken)} per block for this farm: ${state.farmRewardPerBlock.toPrecision(4)} (rewardPerBlock x allocPoint / totalAllocPoint, read live).`,
      partner: state.partner ? `Partner reward ${await symbolOf(state.partner.token)}: ${state.partner.perBlock.toPrecision(4)} per block for ~${Math.round(state.partner.blocksLeft / BLOCKS_PER_DAY)} more days, by share, no multipliers.` : null,
      multipliers: "Rewards are paid at your duration x BOLT multiplier at the moment you collect; the projection assumes you collect at the end of each period.",
      constant: "Held constant: today's emission rate, everyone else's stake and today's prices. The range shows total stake x0.5 to x2 and reward price -50% to +50%.",
      sale: "\"If sold\" is each reward sold to ETN at the best ElectroSwap pool now, after price impact and any sell tax — thin reward tokens can be worth much less than spot.",
      il: "Rewards don't include impermanent loss on the pair — compare them with the IL figure shown.",
    },
  };
}

let farmListCache = { at: 0, value: null };
/** Active ElectroSwap yield farms, for the projection picker: [{ key, id, name, rewards: [symbols] }].
 * Cached 10 minutes — farms are added rarely. */
export async function listActiveFarms() {
  if (farmListCache.value && Date.now() - farmListCache.at < 10 * 60 * 1000) return farmListCache.value;
  const farmC = new ethers.Contract(YIELD_FARM_ADDRESS, [...FARM_ABI, "function farmCount() view returns (uint256)"], getProvider());
  const count = Number(await farmC.farmCount());
  const rewardSym = await symbolOf(canonicalTokenKey((await farmC.rewardToken()).toLowerCase()));
  const out = [];
  for (let id = 1; id <= count; id++) {
    const [farm, tp] = await Promise.all([farmC.getFarmById(id), farmC.getThirdPartyRewardConfigByFarmId(id).catch(() => null)]);
    if (!farm.active) continue;
    const rewards = [];
    if (farm.allocPoint > 0n) rewards.push(rewardSym);
    if (tp && tp.token !== ethers.ZeroAddress && tp.tokensPerBlock > 0n) rewards.push(await symbolOf(canonicalTokenKey(tp.token.toLowerCase())));
    out.push({ key: `farm:${YIELD_FARM_ADDRESS}:${id}`, id, name: farm.name, rewards });
  }
  farmListCache = { at: Date.now(), value: out };
  return out;
}
