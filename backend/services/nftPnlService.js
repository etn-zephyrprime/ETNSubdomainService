// backend/services/nftPnlService.js
//
// Core tier's "ongoing dashboard NFT PnL" — how much you've paid for NFTs and, for anything sold,
// the realized gain/loss — at three levels: across every NFT you've ever touched, per collection,
// and per specific token ID. Built the same way pnlSnapshotService.js's fungible-token live PnL is:
// reuses pnlEventBuilder.js's buildNftEvents (the EXACT same NFT cost-basis/proceeds matching the
// PnL Statement product already uses — see that file's own header comment) and fifoLotEngine.js's
// generic FIFO ledger verbatim, so this can never report a different realized figure than a
// Statement would for the same wallet/NFT/timestamp.
//
// DELIBERATELY NO "current value" for a still-held NFT — unlike a fungible token, there is no
// market-price feed for one specific NFT (pnlPricing.js's getHistoricalPriceUsd throws for exactly
// this reason on an NFT composite key — see its own guard). A collection-wide floor price could
// stand in as a rough estimate (ElectroSwap's NFT endpoints do expose one), but that's a genuinely
// different, lower-confidence number than every other figure this app reports, and wasn't asked
// for — this only surfaces what's actually known: what you paid, and — once sold — what you got and
// the resulting gain/loss. A held NFT's own cost basis is still fully reported, just with no
// "unrealized P&L" implied alongside it.
//
// Composite NFT keys ("collectionAddress:tokenId", see pnlEventBuilder.js's nftAssetKey) are the
// natural per-token-ID grouping key already; per-collection is derived by splitting that key back
// apart, never a second, separately-tracked concept.
import Decimal from "decimal.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { ingestWalletHistory } from "./pnlIngestion.js";
import { replayFifo } from "./fifoLotEngine.js";
import { buildNftEvents } from "./pnlEventBuilder.js";

function parseNftKey(compositeKey) {
  const idx = compositeKey.lastIndexOf(":");
  return { collectionAddress: compositeKey.slice(0, idx), tokenId: compositeKey.slice(idx + 1) };
}

function d(v) {
  return new Decimal(v || 0);
}

/** Turns the FIFO ledger's raw lots/realizedEvents (both keyed by NFT composite key, each possibly
 * appearing more than once per key — a specific NFT can be bought, sold, and rebought) into one
 * row per composite key, held and sold quantities/figures combined. */
function buildByToken(lots, realizedEvents) {
  const heldByToken = new Map(); // compositeKey -> { quantity, costBasisUsd, firstAcquiredAt }
  for (const lot of lots) {
    const qty = d(lot.quantityRemaining);
    if (qty.lte(0)) continue;
    const cost = qty.times(lot.unitCostUsd);
    const existing = heldByToken.get(lot.tokenAddress);
    if (!existing) {
      heldByToken.set(lot.tokenAddress, { quantity: qty, costBasisUsd: cost, firstAcquiredAt: lot.openedTimestamp });
    } else {
      existing.quantity = existing.quantity.plus(qty);
      existing.costBasisUsd = existing.costBasisUsd.plus(cost);
      if (lot.openedTimestamp < existing.firstAcquiredAt) existing.firstAcquiredAt = lot.openedTimestamp;
    }
  }

  const soldByToken = new Map(); // compositeKey -> { quantity, costBasisUsd, proceedsUsd, realizedPnlUsd, lastSoldAt }
  for (const e of realizedEvents) {
    const existing = soldByToken.get(e.tokenAddress);
    if (!existing) {
      soldByToken.set(e.tokenAddress, {
        quantity: d(e.quantityConsumed),
        costBasisUsd: d(e.costBasisUsd),
        proceedsUsd: d(e.proceedsUsd),
        realizedPnlUsd: d(e.realizedPnlUsd),
        lastSoldAt: e.timestamp,
      });
    } else {
      existing.quantity = existing.quantity.plus(e.quantityConsumed);
      existing.costBasisUsd = existing.costBasisUsd.plus(e.costBasisUsd);
      existing.proceedsUsd = existing.proceedsUsd.plus(e.proceedsUsd);
      existing.realizedPnlUsd = existing.realizedPnlUsd.plus(e.realizedPnlUsd);
      if (e.timestamp > existing.lastSoldAt) existing.lastSoldAt = e.timestamp;
    }
  }

  const allKeys = new Set([...heldByToken.keys(), ...soldByToken.keys()]);
  const byToken = [];
  for (const key of allKeys) {
    const { collectionAddress, tokenId } = parseNftKey(key);
    const held = heldByToken.get(key);
    const sold = soldByToken.get(key);
    byToken.push({
      collectionAddress,
      tokenId,
      quantityHeld: held ? held.quantity.toString() : "0",
      heldCostBasisUsd: held ? held.costBasisUsd.toString() : "0",
      firstAcquiredAt: held?.firstAcquiredAt ?? null,
      quantitySold: sold ? sold.quantity.toString() : "0",
      soldCostBasisUsd: sold ? sold.costBasisUsd.toString() : "0",
      proceedsUsd: sold ? sold.proceedsUsd.toString() : "0",
      realizedPnlUsd: sold ? sold.realizedPnlUsd.toString() : "0",
      lastSoldAt: sold?.lastSoldAt ?? null,
    });
  }
  return byToken;
}

/** Rolls a `byToken` list (see buildByToken, or combineLiveNftPnlSnapshots' own merge) up into
 * per-collection totals and the top-level summary — the same three tiers CoreTierNftPnl.jsx shows,
 * built here once so computeLiveNftPnlSnapshot and combineLiveNftPnlSnapshots never derive them two
 * different ways. */
function buildRollups(byToken, unmatchedCount) {
  const byCollectionMap = new Map();
  for (const t of byToken) {
    const c = byCollectionMap.get(t.collectionAddress) || {
      collectionAddress: t.collectionAddress,
      heldTokenCount: 0,
      heldCostBasisUsd: new Decimal(0),
      soldTokenCount: 0,
      soldCostBasisUsd: new Decimal(0),
      proceedsUsd: new Decimal(0),
      realizedPnlUsd: new Decimal(0),
    };
    if (Number(t.quantityHeld) > 0) {
      c.heldTokenCount++;
      c.heldCostBasisUsd = c.heldCostBasisUsd.plus(t.heldCostBasisUsd);
    }
    if (Number(t.quantitySold) > 0) {
      c.soldTokenCount++;
      c.soldCostBasisUsd = c.soldCostBasisUsd.plus(t.soldCostBasisUsd);
      c.proceedsUsd = c.proceedsUsd.plus(t.proceedsUsd);
      c.realizedPnlUsd = c.realizedPnlUsd.plus(t.realizedPnlUsd);
    }
    byCollectionMap.set(t.collectionAddress, c);
  }
  const byCollection = [...byCollectionMap.values()].map((c) => ({
    collectionAddress: c.collectionAddress,
    heldTokenCount: c.heldTokenCount,
    heldCostBasisUsd: c.heldCostBasisUsd.toString(),
    soldTokenCount: c.soldTokenCount,
    soldCostBasisUsd: c.soldCostBasisUsd.toString(),
    proceedsUsd: c.proceedsUsd.toString(),
    realizedPnlUsd: c.realizedPnlUsd.toString(),
  }));

  const heldCostBasisUsd = byCollection.reduce((s, c) => s.plus(c.heldCostBasisUsd), new Decimal(0));
  const soldCostBasisUsd = byCollection.reduce((s, c) => s.plus(c.soldCostBasisUsd), new Decimal(0));
  const proceedsUsd = byCollection.reduce((s, c) => s.plus(c.proceedsUsd), new Decimal(0));
  const realizedPnlUsd = byCollection.reduce((s, c) => s.plus(c.realizedPnlUsd), new Decimal(0));

  return {
    asOf: new Date(),
    // Everything ever paid for an NFT, held or sold — directly "how much I paid for NFTs".
    totalCostBasisUsd: heldCostBasisUsd.plus(soldCostBasisUsd).toString(),
    heldCostBasisUsd: heldCostBasisUsd.toString(),
    soldCostBasisUsd: soldCostBasisUsd.toString(),
    proceedsUsd: proceedsUsd.toString(),
    realizedPnlUsd: realizedPnlUsd.toString(),
    heldTokenCount: byCollection.reduce((s, c) => s + c.heldTokenCount, 0),
    soldTokenCount: byCollection.reduce((s, c) => s + c.soldTokenCount, 0),
    unmatchedCount, // see buildNftEvents' own comment — an NFT leg with no matched same-tx payment, recorded at $0
    byCollection,
    byToken,
  };
}

/**
 * Live NFT PnL for `trackedWallet` as of right now — cost basis for everything currently held,
 * and cost basis / proceeds / realized P&L for everything sold, at all three tiers (top-level,
 * per-collection, per-token-ID). No period concept, same as computeLivePnlSnapshot — a running
 * total since cold-start ingestion, not bound to a calendar range.
 *
 * `selfOwnedAddresses` — the member's other actively-tracked wallets, so an NFT moved between a
 * member's own tracked wallets is correctly excluded from realized P&L (see buildNftEvents'
 * is_self_transfer handling) — same convention computeLivePnlSnapshot already uses.
 */
export async function computeLiveNftPnlSnapshot(trackedWallet, selfOwnedAddresses = []) {
  // Ensures this wallet's transfer history is ingested — cheap/no-op if already done (resumes from
  // last_ingested_block, same as computeLivePnlSnapshot's own call). No priorityAssets scoping: NFT
  // PnL needs no live price lookups at all (see this file's header comment), so there's no "slow
  // first computation" to speed up the way the fungible-token panel has.
  await ingestWalletHistory(trackedWallet, selfOwnedAddresses);

  const now = new Date();
  const transfers = await getAllTransfersBefore(trackedWallet, now);
  const { events, unmatchedCount } = buildNftEvents(transfers);
  events.sort((a, b) => a.timestamp - b.timestamp); // buildNftEvents doesn't sort; FIFO needs chronological order

  const { closing } = replayFifo(events, now, now);
  const byToken = buildByToken(closing.lots, closing.realizedEvents);
  return buildRollups(byToken, unmatchedCount);
}

/** Combines several wallets' own live NFT PnL snapshots into one — same shape/spirit as
 * combineLivePnlSnapshots: merged per composite key (a specific NFT token ID appearing in more
 * than one tracked wallet's history — e.g. sold from one, later bought into another — combines
 * correctly), then re-derives the collection/top-level rollups from that merged list so this is
 * never computed two different ways. */
export function combineLiveNftPnlSnapshots(snapshots) {
  const byTokenMap = new Map(); // compositeKey -> merged Decimal fields
  let unmatchedCount = 0;

  for (const snap of snapshots) {
    unmatchedCount += snap.unmatchedCount || 0;
    for (const t of snap.byToken) {
      const key = `${t.collectionAddress}:${t.tokenId}`;
      const existing = byTokenMap.get(key);
      if (!existing) {
        byTokenMap.set(key, {
          collectionAddress: t.collectionAddress,
          tokenId: t.tokenId,
          quantityHeld: d(t.quantityHeld),
          heldCostBasisUsd: d(t.heldCostBasisUsd),
          firstAcquiredAt: t.firstAcquiredAt,
          quantitySold: d(t.quantitySold),
          soldCostBasisUsd: d(t.soldCostBasisUsd),
          proceedsUsd: d(t.proceedsUsd),
          realizedPnlUsd: d(t.realizedPnlUsd),
          lastSoldAt: t.lastSoldAt,
        });
      } else {
        existing.quantityHeld = existing.quantityHeld.plus(t.quantityHeld);
        existing.heldCostBasisUsd = existing.heldCostBasisUsd.plus(t.heldCostBasisUsd);
        existing.quantitySold = existing.quantitySold.plus(t.quantitySold);
        existing.soldCostBasisUsd = existing.soldCostBasisUsd.plus(t.soldCostBasisUsd);
        existing.proceedsUsd = existing.proceedsUsd.plus(t.proceedsUsd);
        existing.realizedPnlUsd = existing.realizedPnlUsd.plus(t.realizedPnlUsd);
        if (t.firstAcquiredAt && (!existing.firstAcquiredAt || t.firstAcquiredAt < existing.firstAcquiredAt)) {
          existing.firstAcquiredAt = t.firstAcquiredAt;
        }
        if (t.lastSoldAt && (!existing.lastSoldAt || t.lastSoldAt > existing.lastSoldAt)) {
          existing.lastSoldAt = t.lastSoldAt;
        }
      }
    }
  }

  const byToken = [...byTokenMap.values()].map((t) => ({
    collectionAddress: t.collectionAddress,
    tokenId: t.tokenId,
    quantityHeld: t.quantityHeld.toString(),
    heldCostBasisUsd: t.heldCostBasisUsd.toString(),
    firstAcquiredAt: t.firstAcquiredAt,
    quantitySold: t.quantitySold.toString(),
    soldCostBasisUsd: t.soldCostBasisUsd.toString(),
    proceedsUsd: t.proceedsUsd.toString(),
    realizedPnlUsd: t.realizedPnlUsd.toString(),
    lastSoldAt: t.lastSoldAt,
  }));

  return buildRollups(byToken, unmatchedCount);
}
