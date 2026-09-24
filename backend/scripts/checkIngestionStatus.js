// backend/scripts/checkIngestionStatus.js
//
// Read-only — prints one or more wallets' real ingestion state: wallet_ingestion_state's own
// cursors (last_ingested_block/last_ingested_defi_block, compared against the chain's current
// height purely for context — NOT the pass/fail signal, see below) plus cold_start_completed_at,
// and the most recent wallet_ingestion_jobs row (status/progress/stage/error) — the same table
// checkAndStartIngestIfNeeded and the frontend's own progress bar read.
//
// "Fully ingested" here means cold_start_completed_at is set (the wallet has completed at least
// one full history walk successfully, ever) AND its last job didn't end in FAILED. Deliberately
// NOT "cursor is within N blocks of the chain tip" — cursors only advance on a real ingestion run
// (see pnlIngestion.js's own "always sync on reconnect" design), so a healthy wallet that simply
// hasn't reconnected in a while can show a cursor hours behind without that meaning anything is
// broken; it'll catch back up automatically on its own next reconnect.
//
// Usage: node scripts/checkIngestionStatus.js <walletAddress> [walletAddress2] ...
import dotenv from "dotenv";
dotenv.config();

import { getIngestionState } from "../db/walletIngestionState.js";
import { getIngestJob } from "../db/walletIngestionJobs.js";
import { getPool } from "../db/pool.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

const wallets = process.argv.slice(2);
if (wallets.length === 0) {
  console.error("Usage: node scripts/checkIngestionStatus.js <walletAddress> [walletAddress2] ...");
  process.exit(1);
}
if (!getPool()) {
  console.error("DATABASE_URL not set in this shell — can't check the live DB.");
  process.exit(1);
}

async function printStatus(wallet, latestBlock) {
  const [state, job] = await Promise.all([getIngestionState(wallet), getIngestJob(wallet)]);

  console.log(`\n${wallet}`);

  if (!state) {
    console.log("  wallet_ingestion_state: no row at all — never completed a single ingestion run yet.");
  } else {
    const txBehind = state.last_ingested_block != null ? latestBlock - state.last_ingested_block : null;
    const defiBehind = state.last_ingested_defi_block != null ? latestBlock - state.last_ingested_defi_block : null;
    console.log(`  last_ingested_block:      ${state.last_ingested_block}${txBehind != null ? ` (${txBehind.toLocaleString()} blocks behind current tip — informational only, see header comment)` : ""}`);
    console.log(`  last_ingested_defi_block: ${state.last_ingested_defi_block ?? "(never)"}${defiBehind != null ? ` (${defiBehind.toLocaleString()} blocks behind current tip)` : ""}`);
    console.log(`  cold_start_completed_at:  ${state.cold_start_completed_at || "(not yet — still mid cold-start, or has never fully succeeded)"}`);
    console.log(`  state updated_at:         ${state.updated_at}`);
  }

  if (!job) {
    console.log("  wallet_ingestion_jobs: no row — either never run through the progress-tracking path, or predates that table existing.");
  } else {
    console.log(`  last job status:          ${job.status}`);
    console.log(`  last job progress:        block ${job.progress_current} of ${job.progress_total} (${job.stage})`);
    if (job.error_message) console.log(`  last job error:           ${job.error_message}`);
    console.log(`  job updated_at:           ${job.updated_at}`);
  }

  const fullyIngested = Boolean(state?.cold_start_completed_at) && job?.status !== "FAILED" && job?.status !== "RUNNING";
  console.log(`  => ${fullyIngested ? "✅ fully ingested" : job?.status === "RUNNING" ? "⏳ still running" : job?.status === "FAILED" ? "❌ last run FAILED" : "⚠️  cold start not yet completed"}`);
}

async function main() {
  const provider = createRpcProvider();
  const latestBlock = await provider.getBlockNumber();
  console.log(`Current chain tip: block ${latestBlock.toLocaleString()}`);
  for (const wallet of wallets) await printStatus(wallet, latestBlock);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
