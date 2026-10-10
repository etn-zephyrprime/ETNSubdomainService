// backend/scripts/backfillCategoryPnlHistory.js
//
// Manual trigger for the per-category charts' retroactive history fill — "Liquidity Positions"
// and "Staking / Yield Farms" on the Core Tier PnL view (see categoryPnlService.js's own
// backfillCategoryPnlHistory for the actual mechanism/cost shape). Same reason this exists as
// backfillPnlHistory.js's own header comment: normally this only runs once a day, from the same
// scheduler tick that backfills the whole-portfolio chart, so a wallet that's never had that tick
// fire yet (freshly tracked, or backfilled here for the first time after this feature shipped)
// would otherwise show an empty category chart until the next tick. This runs the exact same
// backfillCategoryPnlHistory() function on demand instead of waiting for that.
//
// Unlike backfillPnlHistory.js, there's no separate "write today live" step needed here —
// backfillCategoryPnlHistory() already covers today itself as part of its normal window (see that
// function's own header comment on why: no separate live "right now" display exists for a
// category the way the whole-portfolio chart has one).
//
// Idempotent and safe to re-run — same guarantee backfillCategoryPnlHistory() itself documents: a
// day already recorded for a given category is left alone, so running this against a wallet
// that's already caught up costs one cheap existence check per category and does nothing else.
//
// Usage:
//   node backend/scripts/backfillCategoryPnlHistory.js                  # every actively tracked
//                                                                          # wallet, across every
//                                                                          # Core tier member
//   node backend/scripts/backfillCategoryPnlHistory.js <walletAddress>  # just that one tracked wallet
//   node backend/scripts/backfillCategoryPnlHistory.js <walletAddress> --days=90   # shorter window
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { getAllActiveMemberWallets } from "../db/premiumMemberships.js";
import { hasCoreAccess } from "../utils/premiumAccess.js";
import { backfillCategoryPnlHistory } from "../services/categoryPnlService.js";

dotenv.config();

const DEFAULT_WINDOW_DAYS = 365;

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const windowDays = daysArg ? parseInt(daysArg.split("=")[1], 10) : DEFAULT_WINDOW_DAYS;
const onlyWallet = args[0]?.toLowerCase();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to backfill.");
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`--days must be a positive number, got ${daysArg}`);
  }

  // Seeded from getAllActiveMemberWallets() FIRST (every member's own wallet, unconditionally),
  // not derived purely from tracked_wallets rows — see that function's own comment and
  // backfillPnlHistory.js's identical fix for the full story: tracked_wallets alone misses both a
  // member's own wallet (never a row there) and any member with zero explicitly tracked wallets.
  const [activeMemberWallets, pairs] = await Promise.all([getAllActiveMemberWallets(), getAllActiveTrackedWalletPairs()]);
  if (activeMemberWallets.length === 0) {
    console.log("No active Core tier members found.");
    return;
  }

  const walletsByOwner = new Map();
  for (const owner of activeMemberWallets) walletsByOwner.set(owner, [owner]);
  for (const { owner_wallet, wallet_address } of pairs) {
    if (!walletsByOwner.has(owner_wallet)) walletsByOwner.set(owner_wallet, [owner_wallet]);
    walletsByOwner.get(owner_wallet).push(wallet_address);
  }

  const allCoveredWallets = [...walletsByOwner.values()].flat();
  if (onlyWallet && !allCoveredWallets.some((w) => w.toLowerCase() === onlyWallet)) {
    console.error(`${onlyWallet} isn't covered by any Core tier member (neither their own wallet nor explicitly tracked) — nothing to do.`);
    process.exitCode = 1;
    return;
  }

  let attempted = 0;

  for (const [ownerWallet, wallets] of walletsByOwner) {
    if (!(await hasCoreAccess(ownerWallet))) continue; // premium-only, same gate as the scheduler

    for (const walletAddress of wallets) {
      if (onlyWallet && walletAddress.toLowerCase() !== onlyWallet) continue;
      attempted++;

      const selfOwnedAddresses = wallets.filter((a) => a !== walletAddress);
      console.log(`\n${walletAddress} (owner ${ownerWallet})`);

      try {
        console.log(`  backfilling liquidity + farm/staking history, up to ${windowDays} day(s) including today...`);
        await backfillCategoryPnlHistory(ownerWallet, walletAddress, selfOwnedAddresses, windowDays);
        console.log("  done.");
      } catch (err) {
        console.error(`  ❌ backfill failed: ${err.message}`);
      }
    }
  }

  if (attempted === 0) {
    console.log(onlyWallet ? `${onlyWallet} has no active Core tier membership — nothing to do.` : "No active Core tier members found.");
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Backfill run failed:", err.message);
  process.exitCode = 1;
});
