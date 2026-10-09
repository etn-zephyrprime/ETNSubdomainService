// backend/scripts/resetV3NativeFundedMintWallets.js
//
// One-time repair for wallets whose V3 liquidity mint(s) were silently dropped entirely by the
// strict wallet->pool transfer-leg matching in detectAndRecordV3PositionEvent (pnlIngestion.js).
// Confirmed live against a real Core Tier member's own transaction (reported as a V3 position
// missing entirely from their PnL, 0 open lots AND 0 realized events for it): minting with native
// ETN as one side has the position manager itself call WETN.deposit() using the wallet's
// msg.value, then forward the already-wrapped WETN to the pool — there is no wallet->pool WETN
// transfer to find in that case, so the OLD code declined and dropped the entire mint (both legs,
// not just the unmatched one). The fix (see findV3FundingLeg in pnlIngestion.js) also accepts a
// same-tx WETN Deposit(dst=positionManager, wad=amountRaw) event as equally strong confirmation.
//
// That fix only changes HOW FUTURE ingestion turns on-chain activity into ledger rows — it does
// nothing for a wallet whose mint tx is already behind its own ingestion cursor. Those wallets need
// their ledger cleared and re-ingested from scratch under the corrected logic, same pattern as
// resetV3NftMisclassifiedWallets.js and resetDefiAffectedWallets.js before it.
//
// SCOPE: unlike those two scripts, this bug's signature is an ABSENCE (a missing row), not a wrong
// one — there is no SQL query that can discover "which wallets have a V3 mint that should have been
// recorded but wasn't" from ingested_transfers alone, the same reasoning resetDefiAffectedWallets.js's
// own header comment gives for why ITS V2-LP case needed --all rather than auto-discovery. So this
// takes explicit wallet addresses, or --all to sweep every actively tracked wallet (needed to catch
// one nobody's reported yet).
//
// DRY RUN BY DEFAULT — this touches real ingested transaction history and tax-relevant PnL data.
//   node backend/scripts/resetV3NativeFundedMintWallets.js <wallet...>              # list only
//   node backend/scripts/resetV3NativeFundedMintWallets.js <wallet...> --apply      # reset + re-ingest them
//   node backend/scripts/resetV3NativeFundedMintWallets.js --all                    # every tracked wallet (dry run)
//   node backend/scripts/resetV3NativeFundedMintWallets.js --all --apply            # every tracked wallet, applied
//
// Safe to re-run: a wallet with nothing left to reset just re-ingests cleanly (same idempotent
// resumability every other ingestWalletHistory caller already relies on).
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool, query } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { clearDefiTopicProgress } from "../db/defiScanProgress.js";
import { ingestWalletHistory } from "../services/pnlIngestion.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");
const explicitWallets = args.filter((a) => !a.startsWith("--")).map((a) => a.toLowerCase());

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to repair.");
  }
  if (!all && explicitWallets.length === 0) {
    throw new Error("Pass at least one wallet address, or --all to sweep every actively tracked wallet.");
  }
  for (const w of explicitWallets) {
    if (!ethers.isAddress(w)) throw new Error(`Not a valid address: ${w}`);
  }

  const pairs = await getAllActiveTrackedWalletPairs(); // [{ owner_wallet, wallet_address }]
  const ownerToWallets = new Map();
  const allTrackedWallets = new Set();
  for (const { owner_wallet, wallet_address } of pairs) {
    if (!ownerToWallets.has(owner_wallet)) ownerToWallets.set(owner_wallet, []);
    ownerToWallets.get(owner_wallet).push(wallet_address);
    allTrackedWallets.add(wallet_address);
  }

  const targetWallets = all ? [...allTrackedWallets] : explicitWallets;

  if (targetWallets.length === 0) {
    console.log("Nothing to repair — no actively tracked wallets found.");
    await getPool().end();
    return;
  }

  console.log(`${apply ? "Resetting and re-ingesting" : "Would reset and re-ingest"} ${targetWallets.length} wallet(s):\n`);
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
      // See defi_scan_topic_progress's own migration comment — a stale per-topic checkpoint left
      // behind here would make the cold-start re-ingest below wrongly skip re-fetching blocks whose
      // defi_activity rows were just deleted above.
      await clearDefiTopicProgress(walletLc);
      // Every owner tracking this address, not just one — same reasoning as resetDefiAffectedWallets.js.
      await query("DELETE FROM pnl_snapshots WHERE wallet_address = $1", [walletLc]);
      console.log("  cleared, re-ingesting (this can take a while for a wallet with real history)...");

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

  console.log(`\nDone — ${succeeded} wallet(s) reset and re-ingested under the corrected V3-mint-funding-leg logic${failed > 0 ? `, ${failed} failed (see above; safe to re-run this script — it's idempotent)` : ""}.`);
  console.log("The Value Over Time CHART's pnl_snapshots rows were only cleared here, not refilled — run node backend/scripts/backfillPnlHistory.js next to recompute them under the corrected ledger.");

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Repair run failed:", err.message);
  process.exitCode = 1;
});
