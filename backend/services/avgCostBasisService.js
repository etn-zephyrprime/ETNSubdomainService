// backend/services/avgCostBasisService.js
//
// "Average purchase price per token" for Core Tier's Combined Holdings (CoreTierPortfolio.jsx) —
// in USD and in ETN. The USD figure is cheap: every open lot already carries its own unitCostUsd
// (see fifoLotEngine.js), so a quantity-weighted average is just costBasisUsd/quantity, already
// summed per token by getLedgerState's own closing.lots. ETN is the real new work: a lot's cost
// basis is only ever recorded in USD, so "how much ETN-equivalent value was actually spent"
// requires knowing ETN's own REAL price at the exact moment each lot was acquired, not today's
// rate applied retroactively (which would just be a rescaled copy of the USD figure, not a
// genuine historical average — confirmed decision, see the session this was asked in). That's one
// getHistoricalPriceUsd(NATIVE_SENTINEL, ...) lookup per DISTINCT lot acquisition date — the same
// day-bucketed, memoized pricing path gas costs and self-transfers already lean on throughout this
// app, so in practice almost every lookup here is a cache hit, not a fresh fetch.
//
// Deliberately NOT built by extending pnlEventBuilder.js's valueInventoryAtTimestamp (the function
// every other holdings/snapshot view already shares) — that function is called from several
// places that have no use for a per-lot ETN price lookup (PDF statement generation, the live
// snapshot's own market-value pricing), and adding this work there unconditionally would slow all
// of them down for a feature only this one panel needs. This is a fully separate, additive
// computation over the exact same already-cached ledger (getLedgerState) instead.
//
// Returns RAW totals per token (quantity/costBasisUsd/costBasisEtn/etnQuantity as decimal strings),
// not an already-divided average — a member can have more than one tracked wallet, and combining
// several wallets' own AVERAGES would be wrong (needs combining the raw sums first, exactly like
// pnlSnapshotService.js's own combineLivePnlSnapshots does for holdings); dividing into a final
// average is the caller's job, once wallets are merged.
import Decimal from "decimal.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";
import { NATIVE_SENTINEL } from "./pnlEventBuilder.js";
import { getLedgerState } from "./pnlSnapshotService.js";

export async function getCostBasisTotalsByToken(trackedWallet, selfOwnedAddresses = []) {
  const { closing } = await getLedgerState(trackedWallet, selfOwnedAddresses, null);

  const byToken = new Map(); // tokenAddress -> { quantity, costBasisUsd, costBasisEtn, etnQuantity } (all Decimal)
  for (const lot of closing.lots) {
    const entry = byToken.get(lot.tokenAddress) || {
      quantity: new Decimal(0),
      costBasisUsd: new Decimal(0),
      costBasisEtn: new Decimal(0),
      etnQuantity: new Decimal(0), // may be < quantity if an ETN price lookup failed for one lot — see below
    };
    entry.quantity = entry.quantity.plus(lot.quantityRemaining);
    entry.costBasisUsd = entry.costBasisUsd.plus(lot.quantityRemaining.times(lot.unitCostUsd));

    try {
      const etnPriceUsd = await getHistoricalPriceUsd(NATIVE_SENTINEL, lot.openedTimestamp);
      if (Number.isFinite(etnPriceUsd) && etnPriceUsd > 0) {
        entry.costBasisEtn = entry.costBasisEtn.plus(lot.quantityRemaining.times(lot.unitCostUsd).dividedBy(etnPriceUsd));
        entry.etnQuantity = entry.etnQuantity.plus(lot.quantityRemaining);
      }
    } catch (err) {
      // A single lot's ETN price failing to resolve must never take down the USD figure (already
      // computed above) or any other token's own total — same "best-effort, never let one gap
      // block everything else" posture as pnlEventBuilder.js's own per-token try/catch.
      console.warn(`⚠️  Avg cost basis: couldn't price ETN at ${lot.openedTimestamp?.toISOString?.() || lot.openedTimestamp}:`, err.message);
    }

    byToken.set(lot.tokenAddress, entry);
  }

  const totals = {};
  for (const [tokenAddress, entry] of byToken) {
    if (entry.quantity.lte(0)) continue; // fully disposed — nothing currently held to show an average cost for
    totals[tokenAddress] = {
      quantity: entry.quantity.toString(),
      costBasisUsd: entry.costBasisUsd.toString(),
      costBasisEtn: entry.costBasisEtn.toString(),
      etnQuantity: entry.etnQuantity.toString(),
    };
  }
  return totals;
}
