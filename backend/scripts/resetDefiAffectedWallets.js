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
// Pass --wetn-legs to reset only wallets whose existing V2 LP / V3 position legs include WETN —
// the scope for the native-ETN-as-WETN fix (router addLiquidityETH/removeLiquidityETH, V3 mint with
// msg.value, collect+unwrapWETH9 used to be booked as WETN, leaving phantom WETN and ETN that was
// never deducted/credited).
//
// Pass explicit wallet address(es) to scope to just those instead -- needed for a wallet reported
// individually (confirmed live: a member's wallet whose DeFi scan cursor advanced under some
// earlier, since-fixed version of the farm-detection logic, leaving it with REAL farm activity the
// current code can find just fine when queried directly, but zero defi_activity rows recorded —
// meaning the default scope above would never have picked it up, since that scope requires an
// EXISTING row to even consider a wallet "affected", and --all would reset every tracked wallet
// app-wide just to fix one member's). Explicit wallets don't need to already be in
// getAllActiveTrackedWalletPairs() — ingestWalletHistory handles a standalone address the same way
// it handles any wallet's very first-ever ingestion.
//
// DRY RUN BY DEFAULT -- this touches real ingested transaction history and tax-relevant PnL data.
//   node backend/scripts/resetDefiAffectedWallets.js                 # list affected wallets (defi_activity only)
//   node backend/scripts/resetDefiAffectedWallets.js --apply         # actually reset + re-ingest them
//   node backend/scripts/resetDefiAffectedWallets.js --all           # scope to every tracked wallet (dry run)
//   node backend/scripts/resetDefiAffectedWallets.js --all --apply   # reset + re-ingest every tracked wallet
//   node backend/scripts/resetDefiAffectedWallets.js <wallet...>             # scope to just these wallets (dry run)
//   node backend/scripts/resetDefiAffectedWallets.js <wallet...> --apply     # reset + re-ingest just these wallets
//
// Safe to re-run: a wallet with nothing left to reset just re-ingests cleanly (same idempotent
// resumability every other ingestWalletHistory caller already relies on).
//
// CHECKPOINTED (--apply only): the target list is stored in maintenance_run_wallets when a run
// starts and each wallet is marked done as it finishes, so re-running the SAME command after the
// instance restarts (which kills the job and wipes its log -- see migration 021) resumes with the
// wallets that aren't done yet, from the stored list rather than a recomputed scope. Once every
// wallet is done, the next run of that command starts a fresh pass.
//   node backend/scripts/resetDefiAffectedWallets.js --wetn-legs --status    # progress of that run
//   node backend/scripts/resetDefiAffectedWallets.js --wetn-legs --apply --restart  # discard checkpoint, start over
//
// SELF-OWNED SET: each re-ingest is given every OTHER wallet its owner(s) cover — the owner's own
// connected wallet included, same as getCoveredWallets / the PnL panel / the snapshot scheduler.
// Before 2026-10-16 this script left the owner's connected wallet out (and gave an owner's own
// wallet no siblings at all), so a transfer between e.g. a tracked wallet and its owner's wallet was
// ingested as an external sale + buy rather than a self-transfer. is_self_transfer depends only on
// the counterparty, so that's repaired in place, without a re-ingest, by:
//   node backend/scripts/resetDefiAffectedWallets.js --fix-self-flags          # dry run: count rows
//   node backend/scripts/resetDefiAffectedWallets.js --fix-self-flags --apply  # flip them + clear chart rows
// Scopes (--all, --wetn-legs, default) also include owners' own connected wallets now, not just
// wallets someone added as tracked.
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool, query } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { clearDefiTopicProgress } from "../db/defiScanProgress.js";
import { ingestWalletHistory } from "../services/pnlIngestion.js";
import { ensureMaintenanceRunTable, getRunWallets, startRun, markRunWalletDone } from "../db/maintenanceRuns.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");
const wetnLegs = args.includes("--wetn-legs");
const statusOnly = args.includes("--status");
const restart = args.includes("--restart");
const fixSelfFlags = args.includes("--fix-self-flags");
const explicitWallets = args.filter((a) => !a.startsWith("--")).map((a) => a.toLowerCase());
for (const w of explicitWallets) {
  if (!ethers.isAddress(w)) throw new Error(`Not a valid address: ${w}`);
}

// Wallets with a synthetic V2 LP / V3 position leg (log_index <= -2000) recorded as WETN — the ones
// a native-ETN add/remove-liquidity or V3 mint/collect could have been mis-booked for, before those
// legs were recorded as native ETN instead (see pnlIngestion.js's nativeWetnLeg / leg.native /
// isNativeSide). Over-inclusive on purpose (a genuine WETN-token LP leg also matches): a re-ingest
// of a wallet that was already right changes nothing.
async function getWetnLegWallets() {
  const res = await query(
    "SELECT DISTINCT tracked_wallet FROM ingested_transfers WHERE token_address = '0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77' AND log_index <= -2000"
  );
  return new Set((res?.rows || []).map((r) => r.tracked_wallet));
}

async function getDefiActivityWallets() {
  const res = await query("SELECT DISTINCT tracked_wallet FROM defi_activity");
  return new Set((res?.rows || []).map((r) => r.tracked_wallet));
}

// One checkpoint per distinct command, so e.g. a --wetn-legs run and an --all run never resume
// each other's lists.
function jobKey() {
  if (explicitWallets.length > 0) return `resetDefiAffectedWallets:wallets:${[...explicitWallets].sort().join(",")}`;
  if (wetnLegs) return "resetDefiAffectedWallets:wetn-legs";
  if (all) return "resetDefiAffectedWallets:all";
  return "resetDefiAffectedWallets:defi";
}

// Flags a covered wallet's transfers to/from its own sibling wallets as self-transfers — exactly what
// a re-ingest with the correct self-owned set would produce, since ingestion sets is_self_transfer
// purely from counterparty membership (and is_cex only when it isn't self). pnl_snapshots are
// cleared for any wallet that changed, so the next backfillPnlHistory recomputes its chart.
async function repairSelfTransferFlags(coveredWallets, selfOwnedFor) {
  let total = 0;
  for (const walletLc of coveredWallets) {
    const siblings = selfOwnedFor(walletLc);
    if (siblings.length === 0) continue;
    const res = apply
      ? await query(
          `UPDATE ingested_transfers SET is_self_transfer = true, is_cex = false
           WHERE tracked_wallet = $1 AND NOT is_self_transfer AND lower(counterparty_address) = ANY($2)`,
          [walletLc, siblings]
        )
      : await query(
          `SELECT count(*)::int AS n FROM ingested_transfers
           WHERE tracked_wallet = $1 AND NOT is_self_transfer AND lower(counterparty_address) = ANY($2)`,
          [walletLc, siblings]
        );
    const n = apply ? res.rowCount : res.rows[0].n;
    if (n === 0) continue;
    total += n;
    if (apply) await query("DELETE FROM pnl_snapshots WHERE wallet_address = $1", [walletLc]);
    console.log(`  ${walletLc}: ${n} transfer(s) with its own sibling wallets ${apply ? "re-flagged as self-transfers" : "not flagged as self-transfers"}`);
  }
  console.log(
    total === 0
      ? "Every covered wallet's self-transfers are already flagged — nothing to repair."
      : apply
        ? `
Done — ${total} row(s) re-flagged. Run node backend/scripts/backfillPnlHistory.js to recompute the affected wallets' charts.`
        : `
Dry run — ${total} row(s) would be re-flagged. Re-run with --apply.`
  );
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to repair.");
  }

  await ensureMaintenanceRunTable();
  const key = jobKey();
  const checkpoint = await getRunWallets(key);
  const pendingInCheckpoint = checkpoint.filter((r) => r.status !== "done");

  if (statusOnly) {
    if (checkpoint.length === 0) {
      console.log(`No checkpointed run for ${key}.`);
    } else {
      console.log(`${key}: ${checkpoint.length - pendingInCheckpoint.length}/${checkpoint.length} wallet(s) done${pendingInCheckpoint.length === 0 ? " — run complete." : ""}
`);
      for (const r of checkpoint) console.log(`  ${r.status === "done" ? "done   " : "pending"}  ${r.wallet}`);
    }
    await getPool().end();
    return;
  }

  const pairs = await getAllActiveTrackedWalletPairs(); // [{ owner_wallet, wallet_address }]
  if (pairs.length === 0 && explicitWallets.length === 0) {
    console.log("No actively tracked wallets found.");
    return;
  }

  // owner -> every wallet the PnL panel covers for that owner: their own connected wallet plus
  // each tracked one (getCoveredWallets).
  const ownerGroups = new Map();
  for (const { owner_wallet, wallet_address } of pairs) {
    const owner = owner_wallet.toLowerCase();
    if (!ownerGroups.has(owner)) ownerGroups.set(owner, new Set([owner]));
    ownerGroups.get(owner).add(wallet_address.toLowerCase());
  }
  const coveredWallets = [...new Set([...ownerGroups.values()].flatMap((g) => [...g]))];
  // A wallet covered by more than one owner gets the union — its ingested rows are shared by all.
  const selfOwnedFor = (walletLc) => {
    const set = new Set();
    for (const group of ownerGroups.values()) {
      if (group.has(walletLc)) for (const a of group) if (a !== walletLc) set.add(a);
    }
    return [...set];
  };

  if (fixSelfFlags) {
    await repairSelfTransferFlags(coveredWallets, selfOwnedFor);
    await getPool().end();
    return;
  }

  let targetWallets;
  let scopeLabel;
  if (explicitWallets.length > 0) {
    targetWallets = explicitWallets;
    scopeLabel = " (explicit wallet(s))";
  } else if (wetnLegs) {
    const affected = await getWetnLegWallets();
    targetWallets = coveredWallets.filter((w) => affected.has(w));
    scopeLabel = " (have WETN liquidity/V3 legs)";
  } else if (all) {
    targetWallets = coveredWallets;
    scopeLabel = " (--all)";
  } else {
    const defiWallets = await getDefiActivityWallets();
    targetWallets = coveredWallets.filter((w) => defiWallets.has(w));
    scopeLabel = " (have existing DeFi activity)";
  }

  // Resume an unfinished checkpointed run from its STORED list — the recomputed scope above can't be
  // trusted mid-run: a wallet cleared but not yet re-ingested when the last run died has lost the
  // very rows that put it in scope.
  let resuming = false;
  if (apply && !restart && pendingInCheckpoint.length > 0) {
    resuming = true;
    targetWallets = pendingInCheckpoint.map((r) => r.wallet);
    scopeLabel = ` (resuming checkpoint — ${checkpoint.length - pendingInCheckpoint.length}/${checkpoint.length} already done)`;
  }

  if (targetWallets.length === 0) {
    console.log(
      all
        ? "No actively tracked wallets found."
        : "No tracked wallets with existing DeFi activity found — nothing to repair.\n(Pass --all to reset every tracked wallet instead, e.g. to also catch V2 LP-only activity this app has no existing signal for, or pass explicit wallet address(es) to scope to just those.)"
    );
    await getPool().end();
    return;
  }

  console.log(`${apply ? "Resetting and re-ingesting" : "Would reset and re-ingest"} ${targetWallets.length} wallet(s)${scopeLabel}:\n`);
  for (const w of targetWallets) console.log(`  ${w}`);

  if (!apply) {
    console.log("\nDry run — no changes made. Re-run with --apply to actually reset and re-ingest these wallets.");
    console.log(
      "Each one gets wallet_ingestion_state/ingested_transfers/swap_trades/defi_activity/pnl_snapshots cleared, then a full cold-start re-ingest under the corrected logic — a real, potentially slow re-walk of its entire on-chain history, same cost as its first-ever ingestion."
    );
    await getPool().end();
    return;
  }

  if (!resuming) await startRun(key, targetWallets.map((w) => w.toLowerCase()));

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
      // See defi_scan_topic_progress's own migration comment — a stale per-topic checkpoint left
      // behind here would make the cold-start re-ingest below wrongly skip re-fetching blocks whose
      // defi_activity rows were just deleted above.
      await clearDefiTopicProgress(walletLc);
      // Every owner tracking this address, not just one — see this file's own header comment.
      await query("DELETE FROM pnl_snapshots WHERE wallet_address = $1", [walletLc]);
      console.log("  cleared, re-ingesting (this can take a while for a wallet with real history)...");

      await ingestWalletHistory(walletAddress, selfOwnedFor(walletLc));
      await markRunWalletDone(key, walletLc);
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
