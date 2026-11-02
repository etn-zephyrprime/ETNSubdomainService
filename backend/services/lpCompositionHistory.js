// backend/services/lpCompositionHistory.js
//
// Core Tier PnL tab, Liquidity Positions / Staking & Yield Farms: how much of EACH token a position
// held, day by day — token0 vs token1 drifting apart as the pool's price moves and the position
// becomes weighted towards one of them (the impermanent-loss mechanism, made visible).
//
// Nothing here is a new chain scan. Per position and day it needs two things the app already has:
//   1. how much of the position the wallet held — replayed from the ingested history:
//        - V2 LP: the LP token balance (the ledger's own events for that pair address)
//        - V3 position (NonfungiblePositionManager): its liquidity units (the ledger's composite key)
//        - Yield farm: liquidityAdded on each FarmDeposit/FarmIncrease, back to 0 on FarmWithdrawl
//          (raw defi_activity rows — the ledger only records a farm's token0/token1 as locked
//          amounts, which never change while the farm's own position does)
//   2. the pool's price that day — from the two tokens' stored daily USD prices (price_points), so
//      token1 per token0 = price0 / price1.
// and turns them into token amounts with the pool's own maths:
//   - V2 constant product: per LP token, amount0 = g / sqrt(P), amount1 = g * sqrt(P), where
//     g = sqrt(reserve0 * reserve1) / totalSupply, read live today. g only grows as fees accrue, so
//     earlier days read very slightly high — small next to the price-driven swing being shown.
//   - V3 / farm: the standard getAmountsForLiquidity over the position's tick range (every
//     ElectroSwap yield farm is full-range: amount0 = L / sqrtP, amount1 = L * sqrtP).
// Known limits, stated rather than hidden: uncollected fees aren't included (principal only); the
// daily price ratio comes from each token's own daily close, not this exact pool's, so it's a close
// approximation of the pool price rather than the pool's exact one; a V3 position that's since been
// burned can't have its tick range read back, so it's left out.
import { ethers } from "ethers";
import { buildEventsForWallet } from "./pnlSnapshotService.js";
import { POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { probeV2Pool, getSqrtRatioAtTick, getAmountsForLiquidity } from "./lpPositionValuation.js";
import { getPricePointsRange } from "../db/pricePoints.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { registerCache } from "../utils/boundedMap.js";

const WETN = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const Q96 = 2n ** 96n;
const DAY_MS = 86400000;
const WINDOW_DAYS = 365;

// ---- pure parts (tests/lpCompositionHistory.test.js) --------------------------------------------

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** sqrtPriceX96 for a pool from the two tokens' USD prices (token1 per token0, raw units). */
export function sqrtPriceX96FromUsd(price0Usd, price1Usd, decimals0, decimals1) {
  const raw = (price0Usd / price1Usd) * 10 ** (decimals1 - decimals0);
  if (!(raw > 0) || !Number.isFinite(raw)) return null;
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 96));
}

/** Human token amounts of a V3 range position (or a full-range farm, tickLower/tickUpper = null). */
export function v3Amounts(liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1) {
  const L = BigInt(liquidity);
  let a0, a1;
  if (tickLower == null) {
    a0 = (L * Q96) / sqrtPriceX96;
    a1 = (L * sqrtPriceX96) / Q96;
  } else {
    ({ amount0: a0, amount1: a1 } = getAmountsForLiquidity(sqrtPriceX96, getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), L));
  }
  return { amount0: Number(ethers.formatUnits(a0, decimals0)), amount1: Number(ethers.formatUnits(a1, decimals1)) };
}

/** Human token amounts of `lpTokens` V2 LP tokens at price ratio P (human token1 per token0). */
export function v2Amounts(lpTokens, g, priceRatio) {
  const s = Math.sqrt(priceRatio);
  return { amount0: (lpTokens * g) / s, amount1: lpTokens * g * s };
}

/** Each position key's quantity at the end of each day from the ledger events: in/self_in add,
 * out/self_out subtract, a swap moves both of its legs; lock/unlock leave it the wallet's. */
export function dailyQuantities(events, keys, days) {
  const qty = new Map([...keys].map((k) => [k, 0]));
  const out = new Map([...keys].map((k) => [k, []]));
  const first = new Map();
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  let i = 0;
  const apply = (key, d, ts) => {
    if (!qty.has(key)) return;
    qty.set(key, qty.get(key) + d);
    if (!first.has(key)) first.set(key, ts);
  };
  for (const day of days) {
    const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
    for (; i < sorted.length && sorted[i].timestamp < end; i++) {
      const e = sorted[i];
      const ts = Number(e.timestamp);
      const q = (v) => Number(v?.toString?.() ?? v ?? 0);
      if (e.kind === "in" || e.kind === "self_in") apply(e.tokenAddress, q(e.quantity), ts);
      else if (e.kind === "out" || e.kind === "self_out") apply(e.tokenAddress, -q(e.quantity), ts);
      else if (e.kind === "swap") {
        apply(e.soldTokenAddress, -q(e.soldQuantity), ts);
        apply(e.boughtTokenAddress, q(e.boughtQuantity), ts);
      }
    }
    for (const k of keys) out.get(k).push(Math.max(0, qty.get(k)));
  }
  return { byKey: out, first };
}

/** A farm position's liquidity at the end of each day from its defi_activity rows. */
export function dailyFarmLiquidity(rows, days) {
  const sorted = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let L = 0n;
  let i = 0;
  const out = [];
  for (const day of days) {
    const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
    for (; i < sorted.length && new Date(sorted[i].timestamp).getTime() < end; i++) {
      const r = sorted[i];
      if (r.event_type === "farm_deposit") L += BigInt(r.raw_args?.liquidityAdded || 0);
      else if (r.event_type === "farm_withdraw") L = 0n; // a farm withdrawal closes the whole position
    }
    out.push(L);
  }
  return out;
}

/** Turns per-day quantities into chart points: days with a position held, plus the day it closed. */
export function toPoints(days, held, amountsFor) {
  const points = [];
  for (let d = 0; d < days.length; d++) {
    const has = held[d] > 0;
    const had = d > 0 && held[d - 1] > 0;
    if (!has && !had) continue;
    const amounts = has ? amountsFor(d) : { amount0: 0, amount1: 0 };
    if (amounts) points.push({ date: days[d], ...amounts });
  }
  return points;
}

// ---- live part --------------------------------------------------------------------------------

const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const V2_PAIR = ["function getReserves() view returns (uint112, uint112, uint32)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"];
const NPM = ["function positions(uint256) view returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128, uint256, uint256, uint128, uint128)"];
const FARM = ["function getFarmById(uint256) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))"];

const tokenMetaCache = new Map(); // address -> { symbol, decimals }
async function tokenMeta(provider, address) {
  const a = address.toLowerCase();
  if (tokenMetaCache.has(a)) return tokenMetaCache.get(a);
  const c = new ethers.Contract(a, ERC20, provider);
  const [symbol, decimals] = await Promise.all([c.symbol().catch(() => "?"), c.decimals().then(Number).catch(() => 18)]);
  const meta = { symbol: a === WETN ? "ETN" : symbol, decimals };
  tokenMetaCache.set(a, meta);
  return meta;
}

/** Daily USD price per day in `days` for a token, carried forward over gaps (null before any). */
async function dailyPrices(address, days) {
  const asset = address.toLowerCase() === WETN ? "ETN" : address.toLowerCase();
  const from = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 7 * DAY_MS);
  const to = new Date(Date.parse(`${days[days.length - 1]}T23:59:59Z`));
  const rows = await getPricePointsRange(asset, from, to);
  const byDay = new Map(rows.map((r) => [dayKey(new Date(r.timestamp).getTime()), Number(r.price_usd)]));
  let last = null;
  for (const r of rows) if (dayKey(new Date(r.timestamp).getTime()) < days[0]) last = Number(r.price_usd);
  return days.map((d) => {
    if (byDay.get(d) > 0) last = byDay.get(d);
    return last;
  });
}

const compositionCache = registerCache("lpComposition", new Map()); // wallet|ingestion|day -> result
const CACHE_MAX = 24;

/** Every LP/farm position the wallet has held in the last year, with its daily token amounts. */
export async function computeLpCompositionHistory(trackedWallet, selfOwnedAddresses = []) {
  const state = await getIngestionState(trackedWallet).catch(() => null);
  const today = dayKey(Date.now());
  const cacheKey = `${trackedWallet.toLowerCase()}|${[...selfOwnedAddresses].map((a) => a.toLowerCase()).sort().join(",")}|${state?.updated_at ? new Date(state.updated_at).getTime() : "none"}|${today}`;
  const hit = compositionCache.get(cacheKey);
  if (hit) return hit;

  const provider = createRpcProvider();
  const days = [];
  for (let t = Date.parse(`${today}T00:00:00Z`) - WINDOW_DAYS * DAY_MS; t <= Date.parse(`${today}T00:00:00Z`); t += DAY_MS) days.push(dayKey(t));

  const { events, defiActivity } = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, new Date());
  const positions = [];
  const skipped = [];
  const priceCache = new Map();
  const pricesFor = async (address) => {
    const a = address.toLowerCase();
    if (!priceCache.has(a)) priceCache.set(a, await dailyPrices(a, days).catch(() => days.map(() => null)));
    return priceCache.get(a);
  };
  const sqrtAt = (p0, p1, m0, m1, d) => (p0[d] > 0 && p1[d] > 0 ? sqrtPriceX96FromUsd(p0[d], p1[d], m0.decimals, m1.decimals) : null);

  // V2 LP tokens and V3 positions, from the ledger.
  const keys = new Set(events.map((e) => e.tokenAddress).filter(Boolean));
  for (const e of events) if (e.kind === "swap") [e.soldTokenAddress, e.boughtTokenAddress].forEach((k) => k && keys.add(k));
  const v3Keys = [...keys].filter((k) => k.toLowerCase().startsWith(`${POSITION_MANAGER_ADDRESS.toLowerCase()}:`));
  const v2Keys = [];
  for (const k of keys) {
    if (k.includes(":") || k === "NATIVE") continue;
    if (await probeV2Pool(k).catch(() => null)) v2Keys.push(k);
  }
  const { byKey: held } = dailyQuantities(events, new Set([...v3Keys, ...v2Keys]), days);
  const touched = (k) => held.get(k).some((q) => q > 0);

  for (const key of v2Keys.filter(touched)) {
    try {
      const pair = new ethers.Contract(key, V2_PAIR, provider);
      const { token0, token1 } = await probeV2Pool(key);
      const [[r0, r1], supply, lpDec, m0, m1] = await Promise.all([pair.getReserves(), pair.totalSupply(), pair.decimals().then(Number).catch(() => 18), tokenMeta(provider, token0), tokenMeta(provider, token1)]);
      const g = Math.sqrt(Number(ethers.formatUnits(r0, m0.decimals)) * Number(ethers.formatUnits(r1, m1.decimals))) / Number(ethers.formatUnits(supply, lpDec));
      const [p0, p1] = [await pricesFor(token0), await pricesFor(token1)];
      const q = held.get(key);
      positions.push({
        id: key.toLowerCase(), kind: "v2", category: "liquidity", label: `${m0.symbol}/${m1.symbol} V2 LP`,
        token0: { address: token0, symbol: m0.symbol }, token1: { address: token1, symbol: m1.symbol }, open: q[q.length - 1] > 0,
        points: toPoints(days, q, (d) => (p0[d] > 0 && p1[d] > 0 ? v2Amounts(q[d], g, p0[d] / p1[d]) : null)),
      });
    } catch (err) {
      skipped.push({ id: key, reason: err.shortMessage || err.message });
    }
  }

  const npm = new ethers.Contract(POSITION_MANAGER_ADDRESS, NPM, provider);
  for (const key of v3Keys.filter(touched)) {
    const tokenId = key.split(":")[1];
    try {
      const pos = await npm.positions(tokenId);
      const [m0, m1] = await Promise.all([tokenMeta(provider, pos.token0), tokenMeta(provider, pos.token1)]);
      const [p0, p1] = [await pricesFor(pos.token0), await pricesFor(pos.token1)];
      const q = held.get(key);
      positions.push({
        id: key.toLowerCase(), kind: "v3", category: "liquidity", label: `${m0.symbol}/${m1.symbol} V3 #${tokenId}`,
        token0: { address: pos.token0, symbol: m0.symbol }, token1: { address: pos.token1, symbol: m1.symbol }, open: q[q.length - 1] > 0,
        points: toPoints(days, q, (d) => {
          const sp = sqrtAt(p0, p1, m0, m1, d);
          return sp ? v3Amounts(BigInt(Math.round(q[d])), sp, Number(pos.tickLower), Number(pos.tickUpper), m0.decimals, m1.decimals) : null;
        }),
      });
    } catch (err) {
      skipped.push({ id: key, reason: "position no longer readable (burned)" });
    }
  }

  // Yield farms, from the raw farm events.
  const farmRows = new Map();
  for (const r of defiActivity || []) {
    if (r.event_type !== "farm_deposit" && r.event_type !== "farm_withdraw") continue;
    const k = `${String(r.contract_address).toLowerCase()}:${r.farm_id}`;
    if (!farmRows.has(k)) farmRows.set(k, []);
    farmRows.get(k).push(r);
  }
  for (const [k, rows] of farmRows) {
    const [contract, farmId] = k.split(":");
    try {
      const f = await new ethers.Contract(contract, FARM, provider).getFarmById(farmId);
      const [m0, m1] = await Promise.all([tokenMeta(provider, f.token0), tokenMeta(provider, f.token1)]);
      const [p0, p1] = [await pricesFor(f.token0), await pricesFor(f.token1)];
      const L = dailyFarmLiquidity(rows, days);
      const fullRange = Number(f.tickLower) <= -880000 && Number(f.tickUpper) >= 880000;
      positions.push({
        id: k, kind: "farm", category: "farm_staking", label: `${f.name || `${m0.symbol}/${m1.symbol}`} (farm #${farmId})`,
        token0: { address: f.token0, symbol: m0.symbol }, token1: { address: f.token1, symbol: m1.symbol }, open: L[L.length - 1] > 0n,
        points: toPoints(days, L.map((x) => (x > 0n ? 1 : 0)), (d) => {
          const sp = sqrtAt(p0, p1, m0, m1, d);
          return sp ? v3Amounts(L[d], sp, fullRange ? null : Number(f.tickLower), fullRange ? null : Number(f.tickUpper), m0.decimals, m1.decimals) : null;
        }),
      });
    } catch (err) {
      skipped.push({ id: k, reason: err.shortMessage || err.message });
    }
  }

  const result = { positions: positions.filter((p) => p.points.length).sort((a, b) => Number(b.open) - Number(a.open) || (b.points.at(-1).date > a.points.at(-1).date ? 1 : -1)), skipped };
  compositionCache.set(cacheKey, result);
  while (compositionCache.size > CACHE_MAX) compositionCache.delete(compositionCache.keys().next().value);
  return result;
}
