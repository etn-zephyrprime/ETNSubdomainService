// backend/scripts/resetV3NftMisclassifiedWallets.js
//
// One-time repair for wallets whose ingested history was corrupted by the V3-position-treated-as-
// NFT bug (see PR #239, pnlIngestion.js): detectAndRecordV3PositionEvent silently declines per
// POSITION, not per TX, on a failed getV3PositionTokens/pool lookup, an RPC hiccup, or a missing
// matching leg. When it declined, that tx's hash never made it into the downstream exclusion set,
// so the V3 position-manager's own ERC-721 mint/transfer Transfer log fell through into the
// generic NFT ingestion path -- and buildNftEvents then matched it against the SAME underlying
// token0/token1 legs that were the actual LP deposit, misattributing real liquidity capital as
// NFT purchase cost basis (this is what produced the Core Tier demo's inflated NFT PnL).
//
// PR #239 stops this from happening on any FUTURE ingestion, but -- same as resetDefiAffectedWallets.js
// -- it's a change to HOW on-chain activity gets turned into ledger rows, so it does nothing for
// rows already sitting in ingested_transfers from before it shipped. Those rows need to be cleared
// and re-ingested from scratch under the corrected logic.
//
// Clears a wallet's FULL ingestion state (wallet_ingestion_state, ingested_transfers, swap_trades,
// defi_activity, AND pnl_snapshots -- see resetDefiAffectedWallets.js's own comment on why
// pnl_snapshots specifically needs clearing, not just the raw ledger) and immediately re-runs
// ingestWalletHistory for it. NFT PnL itself has no persisted snapshot table to clear (see
// nftPnlService.js's own header comment -- it's computed live, no period concept), so a cleared +
// re-ingested ledger is the whole fix for that panel; pnl_snapshots is cleared for the portfolio-
// value chart's sake, since the same corrupted rows fed into it too (the bad NFT "in" row and any
// V3 underlying-token legs that fell through alongside it both distort the whole-portfolio total,
// not just the NFT panel).
//
// SCOPE: wallets with an existing ingested_transfers row that is exactly the bug's signature --
// an erc721/erc1155 row whose token_address is the NonfungiblePositionManager contract itself.
// That is only ever produced by this bug (a real collectible NFT collection is never deployed at
// that address), so this scoping has no false positives.
//
// DRY RUN BY DEFAULT -- this touches real ingested transaction history and tax-relevant PnL data.
//   node backend/scripts/resetV3NftMisclassifiedWallets.js           # list affected wallets
//   node backend/scripts/resetV3NftMisclassifiedWallets.js --apply   # actually reset + re-ingest them
//
// Safe to re-run: a wallet with nothing left to reset just re-ingests cleanly (same idempotent
// resumability every other ingestWalletHistory caller already relies on).
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { ingestWalletHistory, POSITION_MANAGER_ADDRESS } from "../services/pnlIngestion.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");

async function getMisclassifiedWallets() {
  const res = await query(
    `SELECT DISTINCT tracked_wallet FROM ingested_transfers
     WHERE asset_type IN ('erc721', 'erc1155') AND token_address = $1`,
    [POSITION_MANAGER_ADDRESS]
  );
  return new Set((res?.rows || []).map((r) => r.tracked_wallet));
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to repair.");
  }

  const misclassified = await getMisclassifiedWallets();
  if (misclassified.size === 0) {
    console.log("No wallets found with V3-position-as-NFT rows — nothing to repair.");
    await getPool().end();
    return;
  }

  const pairs = await getAllActiveTrackedWalletPairs(); // [{ owner_wallet, wallet_address }]
  const ownerToWallets = new Map();
  for (const { owner_wallet, wallet_address } of pairs) {
    if (!ownerToWallets.has(owner_wallet)) ownerToWallets.set(owner_wallet, []);
    ownerToWallets.get(owner_wallet).push(wallet_address);
  }

  const targetWallets = [...misclassified];

  console.log(`${apply ? "Resetting and re-ingesting" : "Would reset and re-ingest"} ${targetWallets.length} wallet(s) with V3-position-as-NFT rows:\n`);
  for (const w of targetWallets) console.log(`  ${w}`);

  if (!apply) {
    console.log("\nDry run — no changes made. Re-run with --apply to actually reset and re-ingest these wallets.");
    console.log(
      "Each one gets wallet_ingestion_state/ingested_transfers/swap_trades/defi_activity/pnl_snapshots cleared, then a full cold-start re-ingest under the corrected logic — a real, potentially slow re-walk of its entire on-chain history, same cost as its first-ever ingestion."
    );
    await getPool().end();
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const walletAddress of targetWallets) {
    const walletLc = walletAddress.toLowerCase();
    console.log(`\n${walletAddress}`);
    try {
      await query("DELETE FROM wallet_ingestion_state WHERE tracked_wallet = $1", [walletLc]);
      await query("DELETE FROM ingested_transfers WHERE tracked_wallet = $1", [walletLc]);
      await query("DELETE FROM swap_trades WHERE tracked_wallet = $1", [walletLc]);
      await query("DELETE FROM defi_activity WHERE tracked_wallet = $1", [walletLc]);
      // Every owner tracking this address, not just one — same reasoning as resetDefiAffectedWallets.js.
      await query("DELETE FROM pnl_snapshots WHERE wallet_address = $1", [walletLc]);
      console.log("  cleared, re-ingesting (this can take a while for a wallet with real history)...");

      // pairs may not include this wallet at all (e.g. a demo-only wallet, not a real member's
      // tracked address) — in that case there are no siblings to pass, ingestWalletHistory just
      // treats it as a standalone wallet, same as its very first ingestion ever.
      const owner = pairs.find((p) => p.wallet_address === walletLc)?.owner_wallet;
      const siblings = owner ? (ownerToWallets.get(owner) || []).filter((a) => a !== walletLc) : [];
      await ingestWalletHistory(walletAddress, siblings);
      console.log("  done.");
      succeeded++;
    } catch (err) {
      console.error(`  ❌ failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${succeeded} wallet(s) reset and re-ingested under the corrected V3-position/NFT logic${failed > 0 ? `, ${failed} failed (see above; safe to re-run this script — it's idempotent)` : ""}.`);
  console.log("NFT PnL is computed live (no snapshot to refill) — the panel reflects the corrected ledger immediately.");
  console.log("The Value Over Time CHART's pnl_snapshots rows were only cleared here, not refilled — run node backend/scripts/backfillPnlHistory.js next to recompute them under the corrected ledger.");
  console.log("If any of these are the Core Tier demo wallets, re-run generateDemoSnapshot.js afterward to refresh the public demo snapshot.");

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Repair run failed:", err.message);
  process.exitCode = 1;
});
