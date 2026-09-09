// backend/scripts/resetDefiAffectedWallets.js
//
// One-time repair for wallets whose ingested history needs to be re-walked under the corrected
// DeFi/liquidity ingestion logic (see PRs #198-#201): the double-counting fix, farm/stake deposit
// getting real lock/unlock treatment (was: a disposal), and V2 add/remove-liquidity decomposition
// are all changes to HOW existing on-chain activity gets turned into ledger rows -- none of them
// retroactively fix rows already sitting in ingested_transfers/swap_trades/defi_activity from
// before this shipped. Those rows need to be cleared and re-ingested from scratch under the new
// logic; nothing else recomputes them on its own.
//
// Clears a wallet's FULL ingestion state (wallet_ingestion_state, ingested_transfers, swap_trades,
// defi_activity, AND pnl_snapshots -- see below) and immediately re-runs ingestWalletHistory for
// it, so each affected wallet gets a clean cold-start re-scan in one command rather than just a
// cleared marker waiting for some future natural trigger (a PnL panel view, a Statement request).
//
// pnl_snapshots (the persisted daily chart rollup) is cleared too, not just the raw ingestion
// tables: backfillPnlHistory only ever fills in MISSING days (see its own comment), so a day that
// already has a row -- which every past day does, for any wallet that's used the PnL panel before
// -- would otherwise keep its stale, wrong value forever, never recomputed just because the
// underlying ledger logic changed. Cleared for ALL owners tracking a given wallet_address (not
// scoped to one owner_wallet), since the same tracked address's on-chain activity is what actually
// changed -- every member who tracks it needs their chart recomputed, not just one.
//
// SCOPE: by default, only wallets with existing defi_activity rows -- definitely touched by the
// double-counting fix and the lock/unlock change. Pass --all to reset every actively tracked wallet
// instead, needed to also pick up V2 LP mint/burn activity: this app has no existing signal for
// "this wallet did an add/remove-liquidity trade" (that detection is new), so a wallet with LP
// activity but no farm/staking history isn't identifiable as "affected" from existing data alone.
//
// DRY RUN BY DEFAULT -- this touches real ingested transaction history and tax-relevant PnL data.
//   node backend/scripts/resetDefiAffectedWallets.js                 # list affected wallets (defi_activity only)
//   node backend/scripts/resetDefiAffectedWallets.js --apply         # actually reset + re-ingest them
//   node backend/scripts/resetDefiAffectedWallets.js --all           # scope to every tracked wallet (dry run)
//   node backend/scripts/resetDefiAffectedWallets.js --all --apply   # reset + re-ingest every tracked wallet
//
// Safe to re-run: a wallet with nothing left to reset just re-ingests cleanly (same idempotent
// resumability every other ingestWalletHistory caller already relies on).
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { ingestWalletHistory } from "../services/pnlIngestion.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");

async function getDefiActivityWallets() {
  const res = await query("SELECT DISTINCT tracked_wallet FROM defi_activity");
  return new Set((res?.rows || []).map((r) => r.tracked_wallet));
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to repair.");
  }

  const pairs = await getAllActiveTrackedWalletPairs(); // [{ owner_wallet, wallet_address }]
  if (pairs.length === 0) {
    console.log("No actively tracked wallets found.");
    return;
  }

  const ownerToWallets = new Map();
  for (const { owner_wallet, wallet_address } of pairs) {
    if (!ownerToWallets.has(owner_wallet)) ownerToWallets.set(owner_wallet, []);
    ownerToWallets.get(owner_wallet).push(wallet_address);
  }

  const distinctWallets = [...new Set(pairs.map((p) => p.wallet_address))];
  let targetWallets = distinctWallets;
  if (!all) {
    const defiWallets = await getDefiActivityWallets();
    targetWallets = distinctWallets.filter((w) => defiWallets.has(w.toLowerCase()));
  }

  if (targetWallets.length === 0) {
    console.log(
      all
        ? "No actively tracked wallets found."
        : "No tracked wallets with existing DeFi activity found — nothing to repair.\n(Pass --all to reset every tracked wallet instead, e.g. to also catch V2 LP-only activity this app has no existing signal for.)"
    );
    await getPool().end();
    return;
  }

  console.log(`${apply ? "Resetting and re-ingesting" : "Would reset and re-ingest"} ${targetWallets.length} wallet(s)${all ? " (--all)" : " (have existing DeFi activity)"}:\n`);
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
      // Every owner tracking this address, not just one — see this file's own header comment.
      await query("DELETE FROM pnl_snapshots WHERE wallet_address = $1", [walletLc]);
      console.log("  cleared, re-ingesting (this can take a while for a wallet with real history)...");

      const owner = pairs.find((p) => p.wallet_address === walletAddress)?.owner_wallet;
      const siblings = owner ? (ownerToWallets.get(owner) || []).filter((a) => a !== walletAddress) : [];
      await ingestWalletHistory(walletAddress, siblings);
      console.log("  done.");
      succeeded++;
    } catch (err) {
      console.error(`  ❌ failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${succeeded} wallet(s) reset and re-ingested under the corrected DeFi/liquidity logic${failed > 0 ? `, ${failed} failed (see above; safe to re-run this script — it's idempotent)` : ""}.`);
  console.log("The raw ledger (ingested_transfers/swap_trades/defi_activity) is fully corrected now, and the live PnL panel already reflects it (computeLivePnlSnapshot runs live, every view).");
  console.log("The Value Over Time CHART's pnl_snapshots rows were only cleared here, not refilled — run node backend/scripts/backfillPnlHistory.js next to recompute them under the corrected ledger.");

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Repair run failed:", err.message);
  process.exitCode = 1;
});
