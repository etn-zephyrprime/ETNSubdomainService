// backend/services/whatIfSimulator.js
//
// Core tier "What-If" sell simulator: "if I sold Q of this token from this wallet right now, what
// would happen?" Read-only — nothing is executed, recorded or cached.
//
//  - WHICH lots go: the wallet's real open lots from the same cached FIFO ledger the PnL page uses
//    (getLedgerState), consumed by the ledger's own pure consumeFifo — the one FIFO implementation,
//    so the simulation can never pick different lots than a real sale would be booked against.
//    Locked lots (farm/stake/LP-locker principal) aren't sellable and are excluded.
//  - WHAT it'd fetch: the best direct route into WETN — the ElectroSwap V2 router's getAmountsOut
//    for the token's V2 pair, and the V3 QuoterV2 for each fee tier's pool — whichever pays most.
//    Both are the exact output with the pool fee and price impact already in it (confirmed live: a
//    token's V2 pair can be far shallower than its V3 pool — 100k BOLT fetched 156k ETN via V2 vs
//    219k via the 0.3% V3 pool). Impact is reported against the pre-trade spot price. Single best
//    direct pool only: the ElectroSwap app (UniversalRouter) also splits a large trade across pools
//    and multi-hop routes (seen live: an ETN->BOLT buy went ~85% V3 0.3%, ~10% via DYNO, ~5% V2), so
//    on big sales this is a little conservative — never optimistic. A token with no fillable direct
//    pool falls back to the spot price with no impact figure — said so, never guessed.
//  - USD and ETN are computed separately, never one derived from the other: USD cost basis is each
//    lot's recorded unitCostUsd; ETN cost basis is that USD cost at ETN's own price on the lot's
//    acquisition day (same as avgCostBasisService.js / convertRealizedEventsToEtn), so "would this
//    sale leave me with more ETN than I put in" has a real answer.
//  - Gas: an estimate (swap, plus an approval if the router's allowance is short) at the live gas
//    price, shown separately and netted into the "after gas" line.
//
// simulateExit does the same for a liquidity / farm / staking POSITION (they can't be sold one
// token at a time — an exit returns both tokens plus fees and rewards): what X% out would return,
// optionally all sold to ETN, against the cost basis of the ledger lots that exit would release.
import Decimal from "decimal.js";
import { ethers } from "ethers";
import { getLedgerState } from "./pnlSnapshotService.js";
import { consumeFifo } from "./fifoLotEngine.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";
import { NATIVE_SENTINEL, canonicalTokenKey } from "./pnlEventBuilder.js";
import { getTokenMetadata, POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { getOpenDefiPositionsUsd } from "./defiPositionValuation.js";
import { getLiquidityPositionsUsd, fetchHeldFungibleTokens, getLpLockDetails } from "./lpPositionValuation.js";
import { quoteV2SellToEtn, quoteV3SellToEtn, getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getTradeTax, isTaxExempt } from "../utils/tokenTransferTax.js";

// Gas units — an estimate (a real estimateGas needs the token approval in place and would revert
// without it). V2: a typical swapExactTokensForETH. V3: the quoter's own gasEstimate for the swap
// plus the tx base cost and the router/unwrap overhead around it.
const V2_SWAP_GAS_UNITS = 160000n;
const V3_SWAP_OVERHEAD_GAS_UNITS = 60000n;
const ERC20_ABI = ["function decimals() view returns (uint8)"];

let provider = null;
const getProvider = () => (provider ||= createRpcProvider());

const DAY_MS = 86400000;

export class WhatIfInputError extends Error {}

async function etnUsdAt(timestamp) {
  try {
    const p = await getHistoricalPriceUsd(NATIVE_SENTINEL, timestamp);
    return Number.isFinite(p) && p > 0 ? new Decimal(p) : null;
  } catch {
    return null;
  }
}

/** The best single-hop sale of `qty` (Decimal) of `tokenKey` into ETN right now — see the header.
 * A token's own trade tax (utils/tokenTransferTax.js — CORE: only on its V2 pair) is taken off the
 * amount that pair receives before quoting it; `wallet` (optional) lets an exempt seller skip it.
 * Returns { quote, decimals, symbol, warnings }; throws WhatIfInputError when nothing can price it. */
export async function quoteSell(tokenKey, qty, wallet = null) {
  const isNative = tokenKey === NATIVE_SENTINEL;
  let quote;
  let decimals = 18;
  const warnings = [];
  const meta = isNative ? null : await getTokenMetadata(tokenKey).catch(() => null);
  if (isNative) {
    quote = { source: "native", etnOut: qty, spotEtn: qty, priceImpactPct: new Decimal(0), pairAddress: null, feeTier: null, swapGasUnits: 21000n, alternative: null, sellTax: null };
  } else {
    const erc20 = new ethers.Contract(tokenKey, ERC20_ABI, getProvider());
    decimals = Number(meta?.decimals ?? (await erc20.decimals()));
    const amountInRaw = ethers.parseUnits(qty.toFixed(decimals, Decimal.ROUND_DOWN), decimals);
    const [v2Gross, v3, spotEtnPrice, tax] = await Promise.all([
      quoteV2SellToEtn(getProvider(), tokenKey, amountInRaw),
      quoteV3SellToEtn(getProvider(), tokenKey, amountInRaw),
      getTokenEtnPrice(getProvider(), tokenKey).catch(() => null),
      getTradeTax(getProvider(), tokenKey),
    ]);
    // Sell tax: charged only on the token's own pair (CORE: its V2 pair), so only the V2 quote
    // shrinks — re-quoted on what the pair actually receives. V3 pools are untaxed for CORE.
    let v2 = v2Gross;
    let taxApplied = null;
    if (v2Gross && tax && tax.sellBps > 0 && v2Gross.pairAddress.toLowerCase() === tax.pairAddress && !(await isTaxExempt(getProvider(), tokenKey, wallet))) {
      const netIn = (amountInRaw * BigInt(10000 - tax.sellBps)) / 10000n;
      v2 = await quoteV2SellToEtn(getProvider(), tokenKey, netIn);
      taxApplied = { bps: tax.sellBps, tokens: new Decimal(ethers.formatUnits(amountInRaw - netIn, decimals)) };
    }
    const spotEtn = spotEtnPrice != null && spotEtnPrice > 0 ? qty.times(spotEtnPrice) : null;
    const v2Out = v2 && v2.amountOutRaw > 0n ? v2.amountOutRaw : 0n;
    const v3Out = v3 && v3.amountOutRaw > 0n ? v3.amountOutRaw : 0n;
    if (v2Out > 0n || v3Out > 0n) {
      const useV3 = v3Out > v2Out;
      const etnOut = new Decimal(ethers.formatUnits(useV3 ? v3Out : v2Out, 18));
      const alternativeOut = useV3 ? v2Out : v3Out;
      quote = {
        source: useV3 ? "v3_quoter" : "v2_router",
        etnOut,
        spotEtn,
        // vs the pre-trade spot value; includes the pool fee, which is part of what a seller loses
        priceImpactPct: spotEtn && spotEtn.gt(0) ? Decimal.max(spotEtn.minus(etnOut).div(spotEtn).times(100), 0) : null,
        pairAddress: useV3 ? v3.poolAddress : v2.pairAddress,
        feeTier: useV3 ? v3.fee : 3000,
        swapGasUnits: useV3 ? BigInt(v3.gasEstimate) + V3_SWAP_OVERHEAD_GAS_UNITS : V2_SWAP_GAS_UNITS,
        alternative: alternativeOut > 0n ? { source: useV3 ? "v2_router" : "v3_quoter", etnOut: ethers.formatUnits(alternativeOut, 18) } : null,
        // The token's own sell tax, when the chosen route is the pair it taxes (null otherwise).
        sellTax: !useV3 && taxApplied ? { bps: taxApplied.bps, tokens: taxApplied.tokens.toString() } : null,
      };
      const symbolLabel = meta?.symbol || "This token";
      if (quote.sellTax) {
        warnings.push(`${symbolLabel} charges a ${(quote.sellTax.bps / 100).toFixed(2)}% sell tax on its V2 pair (read from the token contract), which is included above.`);
      } else if (taxApplied && useV3) {
        warnings.push(`Routed through a V3 pool, which avoids ${symbolLabel}'s ${(taxApplied.bps / 100).toFixed(2)}% sell tax on its V2 pair.`);
      }
    } else if (spotEtn) {
      quote = { source: "spot_only", etnOut: spotEtn, spotEtn, priceImpactPct: null, pairAddress: null, feeTier: null, swapGasUnits: V2_SWAP_GAS_UNITS, alternative: null, sellTax: null };
      warnings.push("No direct ElectroSwap pool could fill this sale size — proceeds are at the spot price, without price impact or fees.");
    } else {
      throw new WhatIfInputError("No ElectroSwap pool with a price for this token — there's nothing to sell into");
    }
  }

  return { quote, decimals, symbol: isNative ? "ETN" : meta?.symbol || null, warnings };
}

/**
 * Simulates selling `quantity` (human units, string/number) of `tokenAddress` from `walletAddress`.
 * `selfOwnedAddresses` = the member's other covered wallets (same ledger scoping as the PnL page).
 * Throws WhatIfInputError for a request that can't be simulated (bad quantity, nothing held, not a
 * plain token); returns the full breakdown otherwise.
 */
export async function simulateSell(walletAddress, selfOwnedAddresses, tokenAddress, quantity) {
  const wallet = walletAddress.toLowerCase();
  const isNative = String(tokenAddress).toUpperCase() === NATIVE_SENTINEL;
  const tokenKey = isNative ? NATIVE_SENTINEL : canonicalTokenKey(String(tokenAddress).toLowerCase());
  if (tokenKey !== NATIVE_SENTINEL && (tokenKey.includes(":") || !ethers.isAddress(tokenKey))) {
    throw new WhatIfInputError("Only plain tokens (and ETN) can be simulated — not NFTs or V3 positions");
  }
  let qty;
  try {
    qty = new Decimal(quantity);
  } catch {
    throw new WhatIfInputError("Enter a valid quantity");
  }
  if (!qty.isFinite() || qty.lte(0)) throw new WhatIfInputError("Enter a quantity greater than zero");

  const { closing } = await getLedgerState(wallet, selfOwnedAddresses, null);
  const openLots = closing.lots.filter((l) => l.tokenAddress === tokenKey && l.quantityRemaining.gt(0));
  const heldQuantity = openLots.reduce((s, l) => s.plus(l.quantityRemaining), new Decimal(0));
  const lockedQuantity = (closing.lockedLots || [])
    .filter((l) => l.tokenAddress === tokenKey)
    .reduce((s, l) => s.plus(l.quantityRemaining), new Decimal(0));
  if (heldQuantity.lte(0)) {
    throw new WhatIfInputError(lockedQuantity.gt(0) ? "All of this token is locked in a farm, stake or LP lock — nothing freely held to sell" : "This wallet doesn't hold any of that token");
  }

  const warnings = [];
  if (qty.gt(heldQuantity)) {
    warnings.push(`You only hold ${heldQuantity.toString()} freely — simulated selling all of it instead of ${qty.toString()}.`);
    qty = heldQuantity;
  }
  if (lockedQuantity.gt(0)) warnings.push(`${lockedQuantity.toString()} more is locked (farm/stake/LP lock) and isn't included.`);

  // ---- Which lots: the ledger's own FIFO ----
  const { consumptions, totalCostBasisUsd, remainingShort } = consumeFifo(openLots, qty);
  const lotById = new Map(openLots.map((l) => [l.id, l]));

  // ---- What it'd fetch ----
  const etnUsdCache = await getEtnPriceCache();
  const etnUsd = etnUsdCache?.usd != null ? new Decimal(etnUsdCache.usd) : null;
  if (etnUsd == null) throw new Error("ETN/USD price isn't available right now — try again shortly");

  const { quote, symbol, warnings: quoteWarnings } = await quoteSell(tokenKey, qty, wallet);
  warnings.push(...quoteWarnings);

  const proceedsEtn = quote.etnOut;
  const proceedsUsd = proceedsEtn.times(etnUsd);

  // ---- Per-lot breakdown (USD and ETN separately) ----
  const now = Date.now();
  let costBasisEtn = new Decimal(0);
  let etnIncomplete = false;
  const lots = [];
  for (const c of consumptions) {
    const lot = lotById.get(c.lotId);
    const share = c.quantityConsumed.div(qty);
    const lotProceedsUsd = proceedsUsd.times(share);
    const lotProceedsEtn = proceedsEtn.times(share);
    const priceThen = c.costBasisUsd.gt(0) ? await etnUsdAt(lot.openedTimestamp) : null;
    const lotCostEtn = c.costBasisUsd.isZero() ? new Decimal(0) : priceThen ? c.costBasisUsd.div(priceThen) : null;
    if (lotCostEtn == null) etnIncomplete = true;
    else costBasisEtn = costBasisEtn.plus(lotCostEtn);
    lots.push({
      acquiredAt: lot.openedTimestamp,
      txHash: lot.openedTxHash || null,
      daysHeld: Math.floor((now - new Date(lot.openedTimestamp).getTime()) / DAY_MS),
      quantity: c.quantityConsumed.toString(),
      unitCostUsd: new Decimal(lot.unitCostUsd).toString(),
      costBasisUsd: c.costBasisUsd.toString(),
      costBasisEtn: lotCostEtn?.toString() ?? null,
      proceedsUsd: lotProceedsUsd.toString(),
      proceedsEtn: lotProceedsEtn.toString(),
      gainUsd: lotProceedsUsd.minus(c.costBasisUsd).toString(),
      gainEtn: lotCostEtn ? lotProceedsEtn.minus(lotCostEtn).toString() : null,
      zeroCostBasis: c.costBasisUsd.isZero(),
    });
  }
  if (remainingShort.gt(0)) warnings.push(`${remainingShort.toString()} isn't covered by any recorded lot and is treated as zero cost basis.`);
  if (lots.some((l) => l.zeroCostBasis)) warnings.push("Some lots have no recorded cost (e.g. received without a known price) — their whole proceeds count as gain.");
  if (etnIncomplete) warnings.push("ETN's historical price was missing for some lots — the ETN figures leave those lots out.");

  // ---- Gas estimate ----
  let gas = null;
  try {
    const fee = await getProvider().getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
    if (gasPrice) {
      // Approval isn't checked: the ElectroSwap app may route through its UniversalRouter (Permit2)
      // rather than these routers, so an allowance read here wouldn't say whether one is needed.
      const units = quote.swapGasUnits;
      const gasEtn = new Decimal(ethers.formatEther(units * gasPrice));
      gas = { units: units.toString(), etn: gasEtn.toString(), usd: gasEtn.times(etnUsd).toString(), excludesApproval: !isNative };
    }
  } catch (err) {
    warnings.push("Couldn't read the current gas price — gas isn't included.");
    console.warn("⚠️  What-if: gas estimate failed:", err.message);
  }

  const realizedUsd = proceedsUsd.minus(totalCostBasisUsd);
  const realizedEtn = proceedsEtn.minus(costBasisEtn);
  const gasEtn = gas ? new Decimal(gas.etn) : new Decimal(0);
  const remainingQty = heldQuantity.minus(qty);
  const remainingCost = openLots.reduce((s, l) => s.plus(l.quantityRemaining.times(l.unitCostUsd)), new Decimal(0)).minus(totalCostBasisUsd);

  return {
    walletAddress: wallet,
    tokenAddress: tokenKey,
    symbol,
    quantity: qty.toString(),
    heldQuantity: heldQuantity.toString(),
    lockedQuantity: lockedQuantity.toString(),
    etnUsd: etnUsd.toString(),
    quote: {
      source: quote.source,
      pairAddress: quote.pairAddress,
      feeTier: quote.feeTier,
      alternative: quote.alternative,
      sellTax: quote.sellTax,
      spotEtn: quote.spotEtn?.toString() ?? null,
      priceImpactPct: quote.priceImpactPct?.toString() ?? null,
    },
    proceeds: { etn: proceedsEtn.toString(), usd: proceedsUsd.toString() },
    costBasis: { usd: totalCostBasisUsd.toString(), etn: etnIncomplete ? null : costBasisEtn.toString() },
    realized: { usd: realizedUsd.toString(), etn: etnIncomplete ? null : realizedEtn.toString() },
    gas,
    afterGas: {
      usd: realizedUsd.minus(gas ? gas.usd : 0).toString(),
      etn: etnIncomplete ? null : realizedEtn.minus(gasEtn).toString(),
      proceedsEtn: proceedsEtn.minus(gasEtn).toString(),
    },
    remaining: { quantity: remainingQty.toString(), costBasisUsd: Decimal.max(remainingCost, 0).toString() },
    lotsSummary: summarizeLots(lots),
    lots,
    warnings,
    assumptions: {
      pricedAt: new Date().toISOString(),
      etnUsd: etnUsd.toString(),
      quote: "The single best direct ElectroSwap pool right now (V2 router or V3 quoter), with the pool fee, price impact and any token sell tax included. ElectroSwap's app can split a big trade across pools.",
      lots: "Your oldest purchases first (FIFO), from your ledger. Unknown cost is never treated as $0; uncovered amounts are flagged.",
      etn: "ETN cost = each purchase's USD cost at ETN's price on the day you bought.",
      gas: "Estimated at the current gas price; excludes any one-time token approval.",
    },
  };
}

/** One-line view of the lots a sale/exit would consume: how many, bought between which dates, the
 * quantity-weighted average holding period, and how many have no recorded cost. */
function summarizeLots(lots) {
  if (!lots.length) return { count: 0 };
  const times = lots.map((l) => new Date(l.acquiredAt).getTime());
  const totalQty = lots.reduce((s, l) => s.plus(l.quantity), new Decimal(0));
  const weightedDays = totalQty.gt(0) ? lots.reduce((s, l) => s.plus(new Decimal(l.quantity).times(l.daysHeld)), new Decimal(0)).div(totalQty) : new Decimal(0);
  return {
    count: lots.length,
    firstAcquiredAt: new Date(Math.min(...times)).toISOString(),
    lastAcquiredAt: new Date(Math.max(...times)).toISOString(),
    avgDaysHeld: Math.round(weightedDays.toNumber()),
    zeroCostCount: lots.filter((l) => l.zeroCostBasis).length,
  };
}


// ---- Positions (LP / farm / staking) -----------------------------------------------------------

// Gas units for the exit transaction itself (before any sales) — estimates, same caveat as swaps.
const EXIT_GAS_UNITS = { farm: 300000n, staking: 150000n, v2: 200000n, v3: 250000n };
const BOLT_ADDRESS = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";

const pairLabel = (legs) => (legs || []).map((l) => l.symbol || "?").join("/");
const wholeFmt = (d) => d.toNumber().toLocaleString(undefined, { maximumFractionDigits: 0 });

/** Every exitable position `walletAddress` has, keyed for the simulator:
 * farm:<contract>:<farmId>, staking:<contract>, v2:<pair>, v3:<tokenId>. Live values from the same
 * cached valuations the Portfolio panel shows. */
async function loadPositions(walletAddress) {
  const wallet = walletAddress.toLowerCase();
  const [defi, lp] = await Promise.all([
    getOpenDefiPositionsUsd(wallet).catch(() => null),
    fetchHeldFungibleTokens(wallet)
      .then((tokens) => getLiquidityPositionsUsd(wallet, tokens))
      .catch(() => null),
  ]);
  const out = [];
  for (const p of defi?.positions || []) {
    if (p.kind === "farm") out.push({ key: `farm:${String(p.contractAddress).toLowerCase()}:${p.farmId}`, kind: "farm", label: p.label, raw: p });
    else if (p.kind === "staking") out.push({ key: `staking:${String(p.contractAddress).toLowerCase()}`, kind: "staking", label: p.label, raw: p });
  }
  for (const p of lp?.v2Positions || []) out.push({ key: `v2:${String(p.tokenAddress).toLowerCase()}`, kind: "v2", label: `${pairLabel(p.legs)} LP`, raw: p });
  for (const p of lp?.v3Positions || []) out.push({ key: `v3:${p.tokenId}`, kind: "v3", label: `${pairLabel(p.legs)} V3 #${p.tokenId}`, raw: p });
  return out;
}

/** FIFO cost of taking `quantity` from `lots` (oldest first) — USD from each lot's recorded cost, ETN
 * at ETN's price on each lot's acquisition day. Same lot-consumption rule a real unlock/disposal uses. */
async function costOfLots(lots, quantity) {
  const qty = new Decimal(quantity);
  if (qty.lte(0)) return { costUsd: new Decimal(0), costEtn: new Decimal(0), etnIncomplete: false, shortfall: new Decimal(0), lots: [] };
  const { consumptions, totalCostBasisUsd, remainingShort } = consumeFifo(lots, qty);
  const byId = new Map(lots.map((l) => [l.id, l]));
  let costEtn = new Decimal(0);
  let etnIncomplete = false;
  const now = Date.now();
  const used = [];
  for (const c of consumptions) {
    const lot = byId.get(c.lotId);
    if (c.costBasisUsd.gt(0)) {
      const price = await etnUsdAt(lot.openedTimestamp);
      if (price) costEtn = costEtn.plus(c.costBasisUsd.div(price));
      else etnIncomplete = true;
    }
    used.push({
      acquiredAt: lot.openedTimestamp,
      quantity: c.quantityConsumed.toString(),
      daysHeld: Math.floor((now - new Date(lot.openedTimestamp).getTime()) / DAY_MS),
      zeroCostBasis: c.costBasisUsd.isZero(),
    });
  }
  return { costUsd: totalCostBasisUsd, costEtn, etnIncomplete, shortfall: remainingShort, lots: used };
}

/** What the simulator's pickers offer for `walletAddress`: freely-held tokens (not ETN — it's what
 * you'd be selling into — nor NFTs, V3 position keys or LP pair tokens, which are offered as
 * positions instead), and every exitable LP / farm / staking position. */
export async function listSellableHoldings(walletAddress, selfOwnedAddresses) {
  const wallet = walletAddress.toLowerCase();
  const [{ closing }, positions] = await Promise.all([getLedgerState(wallet, selfOwnedAddresses, null), loadPositions(wallet)]);
  const lpPairs = new Set(positions.filter((p) => p.kind === "v2").map((p) => String(p.raw.tokenAddress).toLowerCase()));
  const byToken = new Map();
  for (const lot of closing.lots) {
    if (lot.quantityRemaining.lte(0) || lot.tokenAddress.includes(":") || lot.tokenAddress === NATIVE_SENTINEL || lpPairs.has(lot.tokenAddress)) continue;
    byToken.set(lot.tokenAddress, (byToken.get(lot.tokenAddress) || new Decimal(0)).plus(lot.quantityRemaining));
  }
  const tokens = (
    await Promise.all(
      [...byToken].map(async ([tokenAddress, quantity]) => {
        const meta = await getTokenMetadata(tokenAddress).catch(() => null);
        return { tokenAddress, symbol: meta?.symbol || null, name: meta?.name || null, quantity: quantity.toString() };
      })
    )
  )
    .filter((r) => r.symbol !== "ES-LP")
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  return {
    tokens,
    positions: positions.map((p) => ({ key: p.key, kind: p.kind, label: p.label, valueUsd: p.raw.totalUsd ?? null })),
  };
}

/**
 * Simulates exiting `exitPct` (0-100] of one position and optionally selling everything it returns
 * to ETN. What comes back, per position type:
 *  - farm (YieldFarm, verified source): principal x exitPct, plus ALL pending trading fees and farm
 *    rewards (any withdrawal collects them in full), plus the staked BOLT only on a 100% exit;
 *  - staking (CoreAscension): CORE x exitPct (an early-exit penalty may apply — flagged);
 *  - V2 LP: the freely-held LP tokens' share x exitPct (LP still in the locker can't be removed);
 *  - V3: liquidity x exitPct, plus all uncollected fees.
 * Cost basis = the ledger lots that exit releases: the locked lots of each principal token for a
 * farm/stake (the same locked queue a real unlock draws from, FIFO), the LP-token lots for V2, the
 * position's lots for V3. Fees and rewards are income with zero cost.
 */
export async function simulateExit(walletAddress, selfOwnedAddresses, positionKey, exitPct, sellToEtn) {
  const wallet = walletAddress.toLowerCase();
  const pct = Number(exitPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new WhatIfInputError("Exit percentage must be between 0 and 100");
  const f = new Decimal(pct).div(100);
  const full = pct === 100;

  const [positions, { closing }, etnUsdCache] = await Promise.all([loadPositions(wallet), getLedgerState(wallet, selfOwnedAddresses, null), getEtnPriceCache()]);
  const pos = positions.find((p) => p.key === positionKey);
  if (!pos) throw new WhatIfInputError("That position isn't open in this wallet any more — refresh and pick again");
  const etnUsd = etnUsdCache?.usd != null ? new Decimal(etnUsdCache.usd) : null;
  if (etnUsd == null) throw new Error("ETN/USD price isn't available right now — try again shortly");

  const p = pos.raw;
  const warnings = [];
  const received = new Map(); // token key -> { tokenAddress, symbol, principal, income }
  const add = (tokenAddress, symbol, principal, income) => {
    const key = canonicalTokenKey(String(tokenAddress).toLowerCase());
    const r = received.get(key) || { tokenAddress: key, symbol: key === NATIVE_SENTINEL ? "ETN" : symbol, principal: new Decimal(0), income: new Decimal(0) };
    r.principal = r.principal.plus(principal || 0);
    r.income = r.income.plus(income || 0);
    received.set(key, r);
  };
  const lotsFor = (list, key) => (list || []).filter((l) => l.tokenAddress === key && l.quantityRemaining.gt(0));
  const costs = [];
  let exitShare = f; // share of the whole position this exit takes (V2: of the freely-held part only)

  if (pos.kind === "farm") {
    for (const leg of p.legs) {
      add(leg.tokenAddress, leg.symbol, new Decimal(leg.amount).times(f), leg.pendingFees);
      const key = canonicalTokenKey(String(leg.tokenAddress).toLowerCase());
      // The principal this exit releases from the locked queue: the net deposited amount, or — when
      // the deposit history doesn't cover it (missing/zero baseline) — what the position holds now.
      const deposited = leg.depositedAmount != null ? new Decimal(leg.depositedAmount) : null;
      const principal = deposited && deposited.gt(0) ? deposited : new Decimal(leg.amount);
      costs.push(await costOfLots(lotsFor(closing.lockedLots, key), principal.times(f)));
    }
    if (p.pendingRewards && Number(p.pendingRewards.amount) > 0) add(p.pendingRewards.tokenAddress, p.pendingRewards.symbol, 0, p.pendingRewards.amount);
    if (Number(p.boltDeposited) > 0) {
      if (full) {
        add(BOLT_ADDRESS, "BOLT", p.boltDeposited, 0);
        costs.push(await costOfLots(lotsFor(closing.lockedLots, BOLT_ADDRESS), p.boltDeposited));
      } else {
        warnings.push(`Your ${wholeFmt(new Decimal(p.boltDeposited))} staked BOLT only comes back when you withdraw 100% of this farm.`);
      }
    }
    if (p.pendingThirdPartyRewards && Number(p.pendingThirdPartyRewards.amount) > 0) add(p.pendingThirdPartyRewards.tokenAddress, p.pendingThirdPartyRewards.symbol, 0, p.pendingThirdPartyRewards.amount);
    else if (p.hasThirdPartyRewards && !p.pendingThirdPartyRewards) warnings.push("This farm also pays a partner reward token that couldn't be read just now, so it isn't included.");
  } else if (pos.kind === "staking") {
    const leg = p.legs[0];
    const amount = new Decimal(leg.amount).times(f);
    add(leg.tokenAddress, leg.symbol, amount, 0);
    costs.push(await costOfLots(lotsFor(closing.lockedLots, canonicalTokenKey(String(leg.tokenAddress).toLowerCase())), amount));
    if (p.currentlyEarly) warnings.push("You are still inside this stake's early-exit window. The contract applies a penalty, which is not deducted here.");
    warnings.push("Pending staking rewards are not included.");
  } else if (pos.kind === "v2") {
    const total = new Decimal(p.quantity || 0);
    const locked = new Decimal(p.lockedQuantity || 0);
    const free = Decimal.max(total.minus(locked), 0);
    // Locked LP can't be removed: the locker's withdraw() requires the lock duration to have elapsed.
    const locks = locked.gt(0) ? (await getLpLockDetails(wallet)).filter((l) => l.pair === String(p.tokenAddress).toLowerCase()) : [];
    const lockLine = (l) => `${wholeFmt(new Decimal(l.amount))} LP ${l.unlocked ? "unlocked (withdraw it from the locker first)" : `locked until ${l.unlockAt.toISOString().slice(0, 10)}`}`;
    if (free.lte(0)) {
      const next = locks.filter((l) => !l.unlocked).sort((a, b) => a.unlockAt - b.unlockAt)[0];
      throw new WhatIfInputError(
        `All of this LP is in an ElectroSwap liquidity lock, so it can't be removed${next ? ` until ${next.unlockAt.toISOString().slice(0, 10)}` : " yet"}.${locks.length ? ` Locks: ${locks.map(lockLine).join("; ")}.` : ""}`
      );
    }
    if (locked.gt(0)) warnings.push(`Only the ${wholeFmt(free)} LP you hold freely is included. The rest is in the locker${locks.length ? `: ${locks.map(lockLine).join("; ")}` : ""}.`);
    const share = free.div(total).times(f);
    exitShare = share;
    for (const leg of p.legs) add(leg.tokenAddress, leg.symbol, new Decimal(leg.amount).times(share), 0);
    costs.push(await costOfLots(lotsFor(closing.lots, String(p.tokenAddress).toLowerCase()), free.times(f)));
  } else if (pos.kind === "v3") {
    for (const leg of p.legs) add(leg.tokenAddress, leg.symbol, new Decimal(leg.amount).times(f), leg.pendingFees);
    const lots = lotsFor(closing.lots, `${POSITION_MANAGER_ADDRESS}:${p.tokenId}`);
    const held = lots.reduce((s, l) => s.plus(l.quantityRemaining), new Decimal(0));
    costs.push(await costOfLots(lots, held.times(f)));
    if (p.inRange === false) warnings.push("This position is out of range right now, so it is entirely one token and earning no fees.");
  }

  // ---- What it's worth: sold to ETN at the best route, or held at spot ----
  const rows = [];
  let totalEtn = new Decimal(0);
  let spotTotalEtn = new Decimal(0);
  const unpricedSymbols = [];
  let swapGas = 0n;
  let swaps = 0;
  for (const r of received.values()) {
    const amount = r.principal.plus(r.income);
    if (amount.lte(0)) continue;
    // Fair value at today's spot price: what removing the position realizes (the position is disposed
    // of and both tokens acquired at this value). Selling them afterwards is a separate second step.
    const spotPrice =
      r.tokenAddress === NATIVE_SENTINEL
        ? new Decimal(1)
        : await getTokenEtnPrice(getProvider(), r.tokenAddress).then((x) => (x ? new Decimal(x) : null)).catch(() => null);
    if (!spotPrice) unpricedSymbols.push(r.symbol || r.tokenAddress);
    const spotEtn = spotPrice ? amount.times(spotPrice) : null;
    if (spotEtn) spotTotalEtn = spotTotalEtn.plus(spotEtn);
    let etn;
    let source = "etn";
    let impactPct = null;
    if (r.tokenAddress === NATIVE_SENTINEL) {
      etn = amount;
    } else if (sellToEtn) {
      try {
        const { quote, warnings: w } = await quoteSell(r.tokenAddress, amount, wallet);
        etn = quote.etnOut;
        source = quote.source;
        impactPct = quote.priceImpactPct;
        swapGas += quote.swapGasUnits;
        swaps++;
        warnings.push(...w.map((x) => (r.symbol && x.startsWith(r.symbol) ? x : `${r.symbol}: ${x}`)));
      } catch (err) {
        etn = new Decimal(0);
        source = "unsellable";
        warnings.push(`${r.symbol || r.tokenAddress}: ${err.message}. Counted as 0.`);
      }
    } else {
      etn = spotEtn ?? new Decimal(0);
      source = spotEtn ? "spot" : "unpriced";
    }
    totalEtn = totalEtn.plus(etn);
    rows.push({
      tokenAddress: r.tokenAddress,
      symbol: r.symbol,
      principal: r.principal.toString(),
      income: r.income.toString(),
      amount: amount.toString(),
      etn: etn.toString(),
      usd: etn.times(etnUsd).toString(),
      spotEtn: spotEtn?.toString() ?? null,
      source,
      priceImpactPct: impactPct?.toString() ?? null,
    });
  }
  const totalUsd = totalEtn.times(etnUsd);

  const costUsd = costs.reduce((s, c) => s.plus(c.costUsd), new Decimal(0));
  const costEtn = costs.reduce((s, c) => s.plus(c.costEtn), new Decimal(0));
  const etnIncomplete = costs.some((c) => c.etnIncomplete);
  if (costs.some((c) => c.shortfall.gt(0))) warnings.push("Part of this position isn't covered by recorded purchases (e.g. history from before tracking began) and counts as zero cost.");
  if (etnIncomplete) warnings.push("ETN's historical price was missing for some purchases, so the ETN figures leave those out.");
  // The fees + rewards share of the total (zero-cost income), valued the same way as the rest.
  const incomeUsd = rows.reduce((s, r) => s.plus(new Decimal(r.usd).times(new Decimal(r.income).div(r.amount))), new Decimal(0));

  let gas = null;
  try {
    const fee = await getProvider().getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
    if (gasPrice) {
      const units = EXIT_GAS_UNITS[pos.kind] + swapGas;
      const gasEtn = new Decimal(ethers.formatEther(units * gasPrice));
      gas = { units: units.toString(), etn: gasEtn.toString(), usd: gasEtn.times(etnUsd).toString(), swaps };
    }
  } catch {
    warnings.push("Couldn't read the current gas price, so gas isn't included.");
  }
  const gasEtn = gas ? new Decimal(gas.etn) : new Decimal(0);
  const pnlUsd = totalUsd.minus(costUsd);
  const pnlEtn = totalEtn.minus(costEtn);
  // A token with no price leaves the P&L unknowable: shown as unavailable, never as if it were $0.
  const pnlAvailable = unpricedSymbols.length === 0;
  if (!pnlAvailable) warnings.push(`${unpricedSymbols.join(", ")} has no price right now, so the profit/loss can't be worked out. The amounts you'd get back are still shown.`);
  const spotTotalUsd = spotTotalEtn.times(etnUsd);
  const removalPnlUsd = spotTotalUsd.minus(costUsd);
  const il = p.impermanentLoss?.lossUsd != null ? new Decimal(p.impermanentLoss.lossUsd).times(exitShare) : null;

  return {
    walletAddress: wallet,
    position: { key: pos.key, kind: pos.kind, label: pos.label, valueUsd: p.totalUsd ?? null },
    exitPct: pct,
    sellToEtn: Boolean(sellToEtn),
    etnUsd: etnUsd.toString(),
    received: rows,
    total: { etn: totalEtn.toString(), usd: totalUsd.toString() },
    // Step 1, removing the position: what it realizes at today's fair value (before any sale).
    atFairValue: { etn: spotTotalEtn.toString(), usd: spotTotalUsd.toString(), pnlUsd: pnlAvailable ? removalPnlUsd.toString() : null },
    incomeUsd: incomeUsd.toString(),
    costBasis: { usd: costUsd.toString(), etn: etnIncomplete ? null : costEtn.toString() },
    pnl: pnlAvailable
      ? { usd: pnlUsd.toString(), pct: costUsd.gt(0) ? pnlUsd.div(costUsd).times(100).toString() : null, etn: etnIncomplete ? null : pnlEtn.toString() }
      : { usd: null, pct: null, etn: null, unavailable: unpricedSymbols },
    afterGas: pnlAvailable
      ? { usd: pnlUsd.minus(gas ? gas.usd : 0).toString(), etn: etnIncomplete ? null : pnlEtn.minus(gasEtn).toString() }
      : { usd: null, etn: null },
    impermanentLoss: p.impermanentLoss ?? null,
    // vs simply having held the deposited tokens, for the part being exited (<= 0: the IL in dollars).
    holdComparisonUsd: il ? il.toString() : null,
    assumptions: {
      pricedAt: new Date().toISOString(),
      etnUsd: etnUsd.toString(),
      received:
        pos.kind === "v2"
          ? "Your share of the pool's current reserves. A V2 pool's trading fees are already inside its reserves, so there's no separate fee line."
          : pos.kind === "farm"
            ? "Your share of the farm's position at the current pool price, plus every pending reward and fee (any withdrawal collects them all). Staked BOLT returns only on a 100% exit."
            : pos.kind === "v3"
              ? "Your position's liquidity at the current pool price, plus all uncollected fees."
              : "Your staked amount.",
      fairValue: "Removing liquidity disposes of the position at today's spot prices and acquires the tokens at that value. The realized P&L at that point is shown before any sale.",
      sale: sellToEtn
        ? "Each token sold to ETN at the single best ElectroSwap pool right now (V2 router or V3 quoter), with fees, price impact and any token sell tax included. Quotes use the pools' current reserves, before your own liquidity comes out, so selling back into the pool you're leaving would cost slightly more."
        : "Nothing is sold; tokens are valued at spot.",
      costBasis: "Cost of what the exit releases from your ledger (FIFO). Unknown cost is never treated as $0; uncovered amounts are flagged.",
      gas: "Estimated at the current gas price; excludes any one-time token approval.",
    },
    gas,
    lotsSummary: summarizeLots(costs.flatMap((c) => c.lots)),
    warnings,
  };
}
