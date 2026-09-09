// backend/scripts/backfillDeferredPrices.js
//
// Manual trigger for pnlIngestion.js's backfillDeferredPrices — re-prices every already-ingested
// transfer/swap-leg row still sitting on a NULL price, for real, using the current pricing
// pipeline (now GeckoTerminal+ElectroSwap merged, see pnlPricing.js). Updates those specific rows
// in place; never re-walks Blockscout.
//
// WHY THIS MATTERS: pnlEventBuilder.js's transferToEvent/swapToEvent read a row's stored price
// with `?? 0` — a transfer or swap leg whose price is still null in the DB becomes a SILENT $0
// cost-basis/proceeds in the FIFO replay, not an "omitted, unknown" event. That's indistinguishable
// from a real $0 in the live PnL panel's Realized P&L figure (a token filtered to $0 could mean
// "never sold" OR "sold, but priced at $0 because ingestion never resolved a price for it") —
// this script is how to tell the difference and actually fix it.
//
// backfillDeferredPrices normally only ever runs automatically once, in the background, right
// after a wallet's FIRST cold-start computation (see pnlSnapshotService.js's own comment) — a
// wallet that's already past cold-start (true for any wallet that's been tracked for a while) never
// gets it triggered again on its own, even though getUnpricedTransfers/getSwapTradesWithUnpricedLegs
// scan a wallet's ENTIRE history (no time bound) for anything still null. This script is the manual
// re-trigger — worth running any time the pricing pipeline itself has meaningfully improved (e.g.
// after the ElectroSwap integration, or the GeckoTerminal+ElectroSwap merge-coverage fix) so
// historical rows priced under the OLD, narrower pipeline get a real chance to resolve now.
//
// Idempotent and safe to re-run: a wallet with nothing left unpriced costs two cheap indexed
// existence queries and does nothing else (see backfillDeferredPrices' own early return).
//
// Usage:
//   node backend/scripts/backfillDeferredPrices.js                  # every actively tracked wallet,
//                                                                     # across every Core tier member
//   node backend/scripts/backfillDeferredPrices.js <walletAddress>  # just that one tracked wallet
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { getAllActiveTrackedWalletPairs } from "../db/pnlSnapshots.js";
import { hasCoreAccess } from "../utils/premiumAccess.js";
import { backfillDeferredPrices } from "../services/pnlIngestion.js";

dotenv.config();

const onlyWallet = process.argv[2]?.toLowerCase();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to backfill.");
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

  let attempted = 0;
  for (const [ownerWallet, wallets] of walletsByOwner) {
    if (!(await hasCoreAccess(ownerWallet))) continue; // premium-only, same gate as the scheduler

    for (const walletAddress of wallets) {
      if (onlyWallet && walletAddress.toLowerCase() !== onlyWallet) continue;
      attempted++;
      console.log(`\n${walletAddress} (owner ${ownerWallet})`);
      try {
        await backfillDeferredPrices(walletAddress);
      } catch (err) {
        console.error(`  ❌ deferred-price backfill failed: ${err.message}`);
      }
    }
  }

  if (attempted === 0) {
    console.log(onlyWallet ? `${onlyWallet} has no active Core tier membership — nothing to do.` : "No Core tier members with active tracked wallets found.");
  } else {
    console.log(`\nDone — checked ${attempted} wallet(s). Any row that's still null after this genuinely has no price data available for that asset/date (see pnlPricing.js's own coverage ceilings).`);
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Deferred-price backfill run failed:", err.message);
  process.exitCode = 1;
});
