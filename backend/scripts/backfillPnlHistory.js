// backend/scripts/backfillPnlHistory.js
//
// Manual trigger for the value-over-time chart's retroactive history fill (see
// pnlSnapshotService.js's backfillPnlHistory for the actual mechanism/cost shape). Normally this
// runs on its own from pnlSnapshotScheduler.js, once per wallet per day, right after "today"'s row
// is written — but that only fires past PNL_SNAPSHOT_HOUR_UTC (default 13:00 UTC) and only once a
// day, so after first deploying this feature there can be a real wait before anyone sees a filled-in
// chart. This runs the exact same backfillPnlHistory() function on demand instead of waiting for
// that tick.
//
// Idempotent and safe to re-run — same guarantee backfillPnlHistory() itself documents: a day that
// already has a pnl_snapshots row is left alone, so running this against a wallet that's already
// caught up costs one cheap existence query and does nothing else.
//
// Usage:
//   node backend/scripts/backfillPnlHistory.js                  # every actively tracked wallet,
//                                                                 # across every Core tier member
//   node backend/scripts/backfillPnlHistory.js <walletAddress>  # just that one tracked wallet
//   node backend/scripts/backfillPnlHistory.js <walletAddress> --days=90   # shorter window
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs, upsertPnlSnapshot } from "../db/pnlSnapshots.js";
import { hasCoreAccess } from "../utils/premiumAccess.js";
import { computeLivePnlSnapshot, backfillPnlHistory } from "../services/pnlSnapshotService.js";

dotenv.config();

const DEFAULT_WINDOW_DAYS = 365;

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const windowDays = daysArg ? parseInt(daysArg.split("=")[1], 10) : DEFAULT_WINDOW_DAYS;
const onlyWallet = args[0]?.toLowerCase();

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to backfill.");
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`--days must be a positive number, got ${daysArg}`);
  }

  const pairs = await getAllActiveTrackedWalletPairs();
  if (pairs.length === 0) {
    console.log("No actively tracked wallets found.");
    return;
  }

  const walletsByOwner = new Map();
  for (const { owner_wallet, wallet_address } of pairs) {
    if (!walletsByOwner.has(owner_wallet)) walletsByOwner.set(owner_wallet, []);
    walletsByOwner.get(owner_wallet).push(wallet_address);
  }

  if (onlyWallet && !pairs.some((p) => p.wallet_address.toLowerCase() === onlyWallet)) {
    console.error(`${onlyWallet} isn't an actively tracked wallet for any Core tier member — nothing to do.`);
    process.exitCode = 1;
    return;
  }

  const today = todayUtcDateString();
  let attempted = 0;

  for (const [ownerWallet, wallets] of walletsByOwner) {
    if (!(await hasCoreAccess(ownerWallet))) continue; // premium-only, same gate as the scheduler

    for (const walletAddress of wallets) {
      if (onlyWallet && walletAddress.toLowerCase() !== onlyWallet) continue;
      attempted++;

      const selfOwnedAddresses = wallets.filter((a) => a !== walletAddress);
      console.log(`\n${walletAddress} (owner ${ownerWallet})`);

      // Make sure "today" exists too — the scheduler normally writes this separately, on its own
      // schedule, and backfillPnlHistory() deliberately never touches "today" itself (see its own
      // comment: that's the scheduler's job). Running this script shouldn't leave the chart missing
      // its most recent point just because the daily tick hasn't happened yet.
      try {
        console.log("  computing today's live snapshot...");
        const snapshot = await computeLivePnlSnapshot(walletAddress, selfOwnedAddresses);
        await upsertPnlSnapshot(ownerWallet, walletAddress, today, {
          totalValueUsd: snapshot.currentValueUsd,
          realizedPnlUsd: snapshot.realizedPnlUsd,
          unrealizedPnlUsd: snapshot.unrealizedPnlUsd,
        });
        console.log(`  today: value=$${snapshot.currentValueUsd} unrealized=$${snapshot.unrealizedPnlUsd} realized=$${snapshot.realizedPnlUsd}`);
      } catch (err) {
        console.warn(`  ⚠️  couldn't compute today's snapshot: ${err.message}`);
      }

      try {
        console.log(`  backfilling up to ${windowDays} past day(s)...`);
        await backfillPnlHistory(ownerWallet, walletAddress, selfOwnedAddresses, windowDays);
        console.log("  done.");
      } catch (err) {
        console.error(`  ❌ backfill failed: ${err.message}`);
      }
    }
  }

  if (attempted === 0) {
    console.log(onlyWallet ? `${onlyWallet} has no active Core tier membership — nothing to do.` : "No Core tier members with active tracked wallets found.");
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Backfill run failed:", err.message);
  process.exitCode = 1;
});
