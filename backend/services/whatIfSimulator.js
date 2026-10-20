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
import Decimal from "decimal.js";
import { ethers } from "ethers";
import { getLedgerState } from "./pnlSnapshotService.js";
import { consumeFifo } from "./fifoLotEngine.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";
import { NATIVE_SENTINEL, canonicalTokenKey } from "./pnlEventBuilder.js";
import { getTokenMetadata } from "./pnlIngestion.js";
import { quoteV2SellToEtn, quoteV3SellToEtn, getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

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
 * Returns { quote, decimals, symbol, warnings }; throws WhatIfInputError when nothing can price it. */
export async function quoteSell(tokenKey, qty) {
  const isNative = tokenKey === NATIVE_SENTINEL;
  let quote;
  let decimals = 18;
  const warnings = [];
  const meta = isNative ? null : await getTokenMetadata(tokenKey).catch(() => null);
  if (isNative) {
    quote = { source: "native", etnOut: qty, spotEtn: qty, priceImpactPct: new Decimal(0), pairAddress: null, feeTier: null, swapGasUnits: 21000n, alternative: null };
  } else {
    const erc20 = new ethers.Contract(tokenKey, ERC20_ABI, getProvider());
    decimals = Number(meta?.decimals ?? (await erc20.decimals()));
    const amountInRaw = ethers.parseUnits(qty.toFixed(decimals, Decimal.ROUND_DOWN), decimals);
    const [v2, v3, spotEtnPrice] = await Promise.all([
      quoteV2SellToEtn(getProvider(), tokenKey, amountInRaw),
      quoteV3SellToEtn(getProvider(), tokenKey, amountInRaw),
      getTokenEtnPrice(getProvider(), tokenKey).catch(() => null),
    ]);
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
      };
    } else if (spotEtn) {
      quote = { source: "spot_only", etnOut: spotEtn, spotEtn, priceImpactPct: null, pairAddress: null, feeTier: null, swapGasUnits: V2_SWAP_GAS_UNITS, alternative: null };
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

  const { quote, symbol, warnings: quoteWarnings } = await quoteSell(tokenKey, qty);
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
    lots,
    warnings,
  };
}

/** What `walletAddress` can sell: every plain token (and ETN) with freely-held open lots in the
 * ledger, with quantity and symbol — the simulator's token picker. NFTs, V3 positions and LP tokens
 * are left out (not sellable into a pool as-is). */
export async function listSellableHoldings(walletAddress, selfOwnedAddresses) {
  const { closing } = await getLedgerState(walletAddress.toLowerCase(), selfOwnedAddresses, null);
  const byToken = new Map();
  for (const lot of closing.lots) {
    if (lot.quantityRemaining.lte(0) || lot.tokenAddress.includes(":")) continue;
    byToken.set(lot.tokenAddress, (byToken.get(lot.tokenAddress) || new Decimal(0)).plus(lot.quantityRemaining));
  }
  const rows = await Promise.all(
    [...byToken].map(async ([tokenAddress, quantity]) => {
      const meta = tokenAddress === NATIVE_SENTINEL ? { symbol: "ETN", name: "Electroneum" } : await getTokenMetadata(tokenAddress).catch(() => null);
      return { tokenAddress, symbol: meta?.symbol || null, name: meta?.name || null, quantity: quantity.toString() };
    })
  );
  // LP pair tokens ("ES-LP") can't be sold into a pool.
  return rows.filter((r) => r.symbol !== "ES-LP").sort((a, b) => (a.tokenAddress === NATIVE_SENTINEL ? -1 : b.tokenAddress === NATIVE_SENTINEL ? 1 : String(a.symbol).localeCompare(String(b.symbol))));
}
