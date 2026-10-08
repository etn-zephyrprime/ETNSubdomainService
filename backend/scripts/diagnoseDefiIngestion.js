// backend/scripts/diagnoseDefiIngestion.js
//
// Why a member's Combined Holdings keeps showing "Still syncing your staked/farmed positions for
// the first time" (CoreTierPortfolio.jsx) indefinitely, instead of that eventually clearing once
// the one-time DeFi-activity scan finishes. Reported live: burny.etn (resolved address below),
// a Core Tier subscriber, has seen this ever since subscribing — past the point where a genuine
// first-time scan should have long since completed.
//
// Checks EVERY wallet this member's Core Tier features actually cover (their own connected
// wallet, which is always covered automatically, plus any explicitly tracked ones — see
// trackedWallets.js's own getCoveredWallets) rather than just the one address passed in, since
// the "still indexing" banner is driven by ANY covered wallet whose job is still RUNNING (see
// premiumDashboardRouter.js's /premium/defi-positions: `ingesting: jobs.length > 0`) — a stuck
// wallet the member never explicitly picked (their own connected wallet, or a second tracked one)
// would show the exact same banner with no way to tell which one from the frontend alone.
//
// For each covered wallet, prints:
//   - wallet_ingestion_jobs row (status/stage/progress/error_message/updated_at) — RUNNING this
//     long after subscribing, or a FAILED row with a real error_message, both point at a genuine
//     stuck/crash-looping scan rather than "just slow".
//   - wallet_ingestion_state row (last_ingested_defi_block, cold_start_completed_at) — a
//     last_ingested_defi_block that's null/0 despite real activity below means the scan has never
//     once gotten past its first page.
//   - defi_activity row count — confirms whether ANY farm/staking events have been found at all,
//     independent of what the job status claims.
//
// Usage:
//   node backend/scripts/diagnoseDefiIngestion.js <ownerWalletAddress>
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool, query } from "../db/pool.js";
import { getIngestJob } from "../db/walletIngestionJobs.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { getCoveredWallets } from "../db/trackedWallets.js";

dotenv.config();

async function main() {
  const [ownerWallet] = process.argv.slice(2);
  if (!ownerWallet || !ethers.isAddress(ownerWallet)) {
    throw new Error("Usage: node backend/scripts/diagnoseDefiIngestion.js <ownerWalletAddress>");
  }
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to check.");
  }

  const covered = await getCoveredWallets(ownerWallet);
  console.log(`${covered.length} covered wallet(s) for ${ownerWallet}:\n`);

  for (const w of covered) {
    console.log(`== ${w.address}${w.isOwnWallet ? " (own connected wallet)" : " (explicitly tracked)"} ==`);

    const job = await getIngestJob(w.address);
    console.log("  wallet_ingestion_jobs:", job ? JSON.stringify(job) : "(none)");

    const state = await getIngestionState(w.address);
    console.log("  wallet_ingestion_state:", state ? JSON.stringify(state) : "(none)");

    const res = await query("SELECT count(*) FROM defi_activity WHERE tracked_wallet = $1", [w.address.toLowerCase()]);
    console.log(`  defi_activity rows: ${res?.rows[0]?.count ?? "?"}`);
    console.log("");
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ DeFi ingestion diagnosis failed:", err.message);
  process.exitCode = 1;
});
