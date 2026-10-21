// backend/services/scenarioStressTest.js
//
// Core Tier Scenarios — Tool 1, portfolio stress test: "if ETN drops 30% and CORE rises 50%, what am
// I worth?" Read-only: everything is computed on the values below; nothing is written anywhere.
//
// Baseline = Current Value, by construction: the components come from the SAME valuation the PnL
// snapshot uses (pnlSnapshotService.computeLiveValuationParts — open lots at live prices, locked
// farm/stake/locker positions valued live), just kept apart instead of folded together. With every
// shock at zero, the scenario total equals that baseline exactly (each multiplier is 1).
//
// Two shock layers, because token prices on this chain come from ETN pools:
//   token USD move = (1 + ETN/USD shock) x (1 + token-vs-ETN shock) - 1
// so a token flat against ETN still falls in USD when ETN does. USD-pegged tokens (PEGGED_USD) are
// held at $1 instead: unaffected by the ETN move, so their ETN price moves inversely.
//
// How each component is revalued:
//   - plain token / staked principal: value x its USD multiplier (linear — it's just the token).
//   - V2 LP (held or locked) and full-range farm positions: value x sqrt(m0 x m1). For a constant-
//     product position, value = 2 x sqrt(k x P0 x P1), so new/old = sqrt(m0 x m1) once arbitrage
//     moves the pool to the new price ratio — exactly where impermanent loss comes from, and exactly
//     1 at zero shock. (YieldFarm positions are always full-range — see isFullRangeFarm.)
//   - concentrated V3 positions: there's no closed form without the range; approximated as full-
//     range and SAID SO in the assumptions (never silently).
// Pending farm rewards/fees aren't part of Current Value, so they're shown separately (repriced too)
// rather than mixed into the baseline. Realized P&L can't change — nothing is sold.
import Decimal from "decimal.js";
import { ethers } from "ethers";
import { getLedgerState, computeLiveValuationParts } from "./pnlSnapshotService.js";
import { getOpenDefiPositionsUsd } from "./defiPositionValuation.js";
import { probeV2Pool } from "./lpPositionValuation.js";
import { NATIVE_SENTINEL, canonicalTokenKey } from "./pnlEventBuilder.js";
import { getTokenMetadata, POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

// USD-pegged tokens, held at $1 in a stress test (open decision: this list is maintained here, by hand).
export const PEGGED_USD = new Map([
  ["0x48e722f1458b253c2fb0e573f939318d7dbd54e7", "USDT"],
  ["0x3187dead7a2bd6770f5fe81495d1b715926aae6e", "USDC"],
  ["0xd70b4b2e14cba41fe011ea0c7021b6e64d960d87", "eUSDT"],
  ["0x74d64c56926e3d758404600b4b6f3954f4216e51", "eUSDC"],
]);

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];
let provider = null;
const getProvider = () => (provider ||= createRpcProvider());

export class StressInputError extends Error {}

// ---- Pure maths --------------------------------------------------------------------------------

/** Validates/normalizes { etnPct, allTokensPct, tokenPct: { [token]: pct } } — every shock > -100%. */
export function normalizeShocks(input = {}) {
  const num = (v, name) => {
    const n = v == null || v === "" ? 0 : Number(v);
    if (!Number.isFinite(n) || n <= -100 || n > 10000) throw new StressInputError(`${name} must be a percentage above -100`);
    return n;
  };
  const tokenPct = {};
  for (const [k, v] of Object.entries(input.tokenPct || {})) tokenPct[String(k).toLowerCase()] = num(v, "Each token shock");
  return { etnPct: num(input.etnPct, "The ETN/USD shock"), allTokensPct: num(input.allTokensPct, "The all-tokens shock"), tokenPct };
}

/** A token's USD price multiplier under `shocks` — see the header for the two-layer model. */
export function usdMultiplier(token, shocks) {
  const key = String(token).toLowerCase();
  if (PEGGED_USD.has(key)) return 1;
  const etn = 1 + shocks.etnPct / 100;
  if (token === NATIVE_SENTINEL || key === "native") return etn;
  const vsEtn = 1 + (shocks.tokenPct[key] ?? shocks.allTokensPct) / 100;
  return etn * vsEtn;
}

/** Applies `shocks` to `components` ([{ kind, tokens, baselineUsd, ... }]) — pure. Returns each with
 * scenarioUsd and its multiplier. */
export function stressComponents(components, shocks) {
  return components.map((c) => {
    const base = new Decimal(c.baselineUsd);
    let factor;
    if (c.kind === "token" || c.kind === "staking") factor = usdMultiplier(c.tokens[0], shocks);
    else factor = Math.sqrt(usdMultiplier(c.tokens[0], shocks) * usdMultiplier(c.tokens[1], shocks)); // lp, farm, v3
    const scenario = base.times(factor);
    return { ...c, factor, scenarioUsd: scenario.toString(), deltaUsd: scenario.minus(base).toString() };
  });
}

// ---- Building the components from the live valuation -------------------------------------------

async function symbolOf(token) {
  if (token === NATIVE_SENTINEL) return "ETN";
  if (PEGGED_USD.has(token)) return PEGGED_USD.get(token);
  return (await getTokenMetadata(token).catch(() => null))?.symbol || `${token.slice(0, 6)}…`;
}

async function v3Tokens(positionKey) {
  const tokenId = positionKey.split(":")[1];
  const pos = await new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, getProvider()).positions(tokenId);
  return [canonicalTokenKey(pos.token0.toLowerCase()), canonicalTokenKey(pos.token1.toLowerCase())];
}

/** One wallet's components, unpriced holdings, pending rewards and the live Current Value they sum to. */
async function buildWalletComponents(wallet, selfOwnedAddresses) {
  const { closing } = await getLedgerState(wallet, selfOwnedAddresses, null);
  const [{ openValuation, positions }, defi] = await Promise.all([
    computeLiveValuationParts(wallet, closing),
    getOpenDefiPositionsUsd(wallet).catch(() => ({ positions: [] })),
  ]);

  const components = [];
  const unpriced = [];
  let usedV3Approximation = false;

  // Open lots: plain tokens, V2 LP tokens (priced per unit by the position valuation), V3 positions.
  for (const row of openValuation.perToken) {
    const key = row.tokenAddress;
    if (row.marketValueUsd == null) {
      if (!key.includes(":")) unpriced.push({ token: key, symbol: await symbolOf(key), quantity: row.quantity });
      continue;
    }
    const base = { wallet, baselineUsd: row.marketValueUsd, costBasisUsd: row.costBasisUsd };
    if (key.includes(":")) {
      const tokens = await v3Tokens(key).catch(() => null);
      if (!tokens) {
        components.push({ ...base, kind: "token", key, tokens: [key], label: `Position ${key.split(":")[1]}` });
        continue;
      }
      usedV3Approximation = true;
      components.push({ ...base, kind: "v3", key, tokens, label: `${await symbolOf(tokens[0])}/${await symbolOf(tokens[1])} V3 #${key.split(":")[1]}` });
    } else if (positions.livePricesUsd[key] != null) {
      const pair = await probeV2Pool(key);
      const tokens = pair ? [canonicalTokenKey(pair.token0), canonicalTokenKey(pair.token1)] : null;
      if (tokens) components.push({ ...base, kind: "lp", key, tokens, label: `${await symbolOf(tokens[0])}/${await symbolOf(tokens[1])} LP` });
      else components.push({ ...base, kind: "token", key, tokens: [key], label: await symbolOf(key) });
    } else {
      components.push({ ...base, kind: "token", key, tokens: [key], label: await symbolOf(key) });
    }
  }

  // Locked: LP in the locker (keyed by pair), and farm/stake principal (keyed by token, possibly
  // spread across several positions — allocated back to each by its live leg value).
  const legsByToken = new Map(); // token -> [{ position, usd }]
  for (const p of defi?.positions || []) {
    for (const leg of p.legs || []) {
      if (leg.usdValue == null) continue;
      const key = canonicalTokenKey(String(leg.tokenAddress).toLowerCase());
      if (!legsByToken.has(key)) legsByToken.set(key, []);
      legsByToken.get(key).push({ position: p, usd: new Decimal(leg.usdValue) });
    }
  }
  const byPosition = new Map(); // position -> { baseline, cost }
  for (const [key, locked] of positions.lockedByToken) {
    const value = new Decimal(locked.marketValueUsd);
    const cost = new Decimal(locked.costBasisUsd);
    const pair = key !== NATIVE_SENTINEL && !legsByToken.has(key) ? await probeV2Pool(key).catch(() => null) : null;
    if (pair) {
      const tokens = [canonicalTokenKey(pair.token0), canonicalTokenKey(pair.token1)];
      components.push({ wallet, kind: "lp", key: `${key}:locked`, tokens, baselineUsd: value.toString(), costBasisUsd: cost.toString(), label: `${await symbolOf(tokens[0])}/${await symbolOf(tokens[1])} LP (locked)` });
      continue;
    }
    const legs = legsByToken.get(key) || [];
    const legTotal = legs.reduce((s, l) => s.plus(l.usd), new Decimal(0));
    if (legTotal.lte(0)) {
      components.push({ wallet, kind: "token", key: `${key}:locked`, tokens: [key], baselineUsd: value.toString(), costBasisUsd: cost.toString(), label: `${await symbolOf(key)} (locked)` });
      continue;
    }
    for (const l of legs) {
      const share = l.usd.div(legTotal);
      const agg = byPosition.get(l.position) || { baseline: new Decimal(0), cost: new Decimal(0) };
      agg.baseline = agg.baseline.plus(value.times(share));
      agg.cost = agg.cost.plus(cost.times(share));
      byPosition.set(l.position, agg);
    }
  }
  const pendingRewards = [];
  for (const [p, agg] of byPosition) {
    const tokens = p.legs.map((l) => canonicalTokenKey(String(l.tokenAddress).toLowerCase()));
    const kind = p.kind === "farm" && tokens.length === 2 ? "farm" : "staking";
    components.push({
      wallet,
      kind,
      key: `${p.kind}:${String(p.contractAddress).toLowerCase()}:${p.farmId ?? ""}`,
      tokens: kind === "farm" ? tokens : [tokens[0]],
      baselineUsd: agg.baseline.toString(),
      costBasisUsd: agg.cost.toString(),
      label: p.label || (kind === "farm" ? "Yield farm" : "Staking"),
    });
  }
  // Pending farm rewards and uncollected fees — NOT in Current Value, shown separately.
  for (const p of defi?.positions || []) {
    if (p.kind !== "farm") continue;
    if (p.pendingRewards && Number(p.pendingRewards.amount) > 0) pendingRewards.push({ wallet, label: p.label, token: canonicalTokenKey(p.pendingRewards.tokenAddress.toLowerCase()), symbol: p.pendingRewards.symbol, amount: p.pendingRewards.amount });
    for (const leg of p.legs || []) {
      if (Number(leg.pendingFees || 0) > 0) pendingRewards.push({ wallet, label: `${p.label} fees`, token: canonicalTokenKey(String(leg.tokenAddress).toLowerCase()), symbol: leg.symbol, amount: leg.pendingFees });
    }
  }

  const lockedTotal = [...positions.lockedByToken.values()].reduce((s, l) => s.plus(l.marketValueUsd), new Decimal(0));
  return {
    components,
    unpriced,
    pendingRewards,
    usedV3Approximation,
    liveCurrentValueUsd: openValuation.totalMarketValueUsd.plus(lockedTotal),
    costBasisUsd: [...openValuation.perToken.filter((r) => r.marketValueUsd != null).map((r) => new Decimal(r.costBasisUsd)), ...[...positions.lockedByToken.values()].map((l) => new Decimal(l.costBasisUsd))].reduce((s, d) => s.plus(d), new Decimal(0)),
  };
}

async function tokenUsdPrice(token, etnUsd) {
  if (PEGGED_USD.has(token)) return new Decimal(1);
  if (token === NATIVE_SENTINEL) return etnUsd;
  const etn = await getTokenEtnPrice(getProvider(), token).catch(() => null);
  return etn != null && etn > 0 ? etnUsd.times(etn) : null;
}

/**
 * Runs the stress test for `wallets` (one tracked wallet, or all of a member's) — each valued with the
 * member's other tracked wallets as self-owned, exactly like the PnL page. Read-only.
 */
export async function runStressTest(wallets, allCoveredAddresses, rawShocks) {
  const shocks = normalizeShocks(rawShocks);
  const etnCache = await getEtnPriceCache();
  if (etnCache?.usd == null) throw new Error("ETN/USD price isn't available right now — try again shortly");
  const etnUsd = new Decimal(etnCache.usd);
  const etnMult = 1 + shocks.etnPct / 100;

  const parts = [];
  for (const w of wallets) parts.push(await buildWalletComponents(w, allCoveredAddresses.filter((a) => a !== w)));
  const components = parts.flatMap((p) => p.components);
  const stressed = stressComponents(components, shocks);

  // Merge plain-token rows across wallets (one row per token in the table).
  const rowsByKey = new Map();
  for (const c of stressed) {
    const k = c.kind === "token" ? `token:${c.key}` : `${c.kind}:${c.key}:${wallets.length > 1 ? c.wallet : ""}`;
    const r = rowsByKey.get(k) || { ...c, baselineUsd: "0", scenarioUsd: "0", deltaUsd: "0", costBasisUsd: "0" };
    for (const f of ["baselineUsd", "scenarioUsd", "deltaUsd", "costBasisUsd"]) r[f] = new Decimal(r[f]).plus(c[f] ?? 0).toString();
    rowsByKey.set(k, r);
  }
  const rows = [...rowsByKey.values()]
    .map(({ wallet, ...r }) => ({ ...r, wallet: wallets.length > 1 && r.kind !== "token" ? wallet : undefined }))
    .sort((a, b) => Math.abs(Number(b.deltaUsd)) - Math.abs(Number(a.deltaUsd)));

  const baselineUsd = stressed.reduce((s, c) => s.plus(c.baselineUsd), new Decimal(0));
  const scenarioUsd = stressed.reduce((s, c) => s.plus(c.scenarioUsd), new Decimal(0));
  const liveCurrentValueUsd = parts.reduce((s, p) => s.plus(p.liveCurrentValueUsd), new Decimal(0));
  const costBasisUsd = parts.reduce((s, p) => s.plus(p.costBasisUsd), new Decimal(0));

  // Pending rewards/fees, repriced the same way (spot price x the token's multiplier).
  const pending = [];
  for (const r of parts.flatMap((p) => p.pendingRewards)) {
    const price = await tokenUsdPrice(r.token, etnUsd);
    if (price == null) continue;
    const base = new Decimal(r.amount).times(price);
    pending.push({ ...r, baselineUsd: base.toString(), scenarioUsd: base.times(usdMultiplier(r.token, shocks)).toString() });
  }
  const pendingBase = pending.reduce((s, r) => s.plus(r.baselineUsd), new Decimal(0));
  const pendingScenario = pending.reduce((s, r) => s.plus(r.scenarioUsd), new Decimal(0));

  const unpriced = parts.flatMap((p) => p.unpriced);
  const toEtn = (usd, mult) => new Decimal(usd).div(etnUsd.times(mult));
  const change = scenarioUsd.minus(baselineUsd);
  const baselineEtn = toEtn(baselineUsd, 1);
  const scenarioEtn = toEtn(scenarioUsd, etnMult);

  return {
    shocks,
    etnUsd: etnUsd.toString(),
    baseline: { usd: baselineUsd.toString(), etn: baselineEtn.toString() },
    scenario: { usd: scenarioUsd.toString(), etn: scenarioEtn.toString() },
    change: {
      usd: change.toString(),
      pct: baselineUsd.gt(0) ? change.div(baselineUsd).times(100).toString() : null,
      etn: scenarioEtn.minus(baselineEtn).toString(),
      etnPct: baselineEtn.gt(0) ? scenarioEtn.minus(baselineEtn).div(baselineEtn).times(100).toString() : null,
    },
    unrealized: { beforeUsd: baselineUsd.minus(costBasisUsd).toString(), afterUsd: scenarioUsd.minus(costBasisUsd).toString(), costBasisUsd: costBasisUsd.toString() },
    rows: rows.map((r) => ({ kind: r.kind, key: r.key, label: r.label, tokens: r.tokens, wallet: r.wallet, baselineUsd: r.baselineUsd, scenarioUsd: r.scenarioUsd, deltaUsd: r.deltaUsd, factor: r.factor })),
    tokens: await Promise.all(
      [...new Set(components.flatMap((c) => c.tokens))].map(async (t) => ({ token: t, symbol: await symbolOf(t), pegged: PEGGED_USD.has(t), native: t === NATIVE_SENTINEL }))
    ),
    pendingRewards: { baselineUsd: pendingBase.toString(), scenarioUsd: pendingScenario.toString(), items: pending },
    unpriced: { count: unpriced.length, items: unpriced },
    baselineCheck: { liveCurrentValueUsd: liveCurrentValueUsd.toString(), diffUsd: baselineUsd.minus(liveCurrentValueUsd).toString() },
    assumptions: {
      pricedAt: new Date().toISOString(),
      etnUsd: etnUsd.toString(),
      model: "Token price in USD = its price in ETN x ETN/USD. Each shock multiplies one layer: USD move = (1 + ETN shock) x (1 + token-vs-ETN shock) - 1.",
      pegged: [...PEGGED_USD.values()],
      liquidity: "V2 LP and full-range yield-farm positions are revalued along the constant-product curve (value x sqrt(m0 x m1)), so the impermanent loss a price move causes is included.",
      v3Approximation: parts.some((p) => p.usedV3Approximation) ? "Concentrated V3 positions are approximated as full-range — a range position can move more (or stop earning) than shown." : null,
      pendingRewards: "Pending farm rewards and uncollected fees aren't part of Current Value, so they're shown separately rather than added in.",
      realized: "Realized P&L doesn't change in a stress test — nothing is sold.",
      coverage: unpriced.length ? `${unpriced.length} holding(s) have no price and are excluded.` : "Every holding has a price.",
    },
  };
}
