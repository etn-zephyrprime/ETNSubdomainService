// backend/scripts/checkStatementRequest.js
//
// Read-only — prints one statement request's full row (status/first_viewed_at/finalized_at/etc.)
// plus whether it has a buy_and_burn_log entry yet. Built to answer the exact question
// diagnoseSplitExecution.js's own "0 FINALIZED" output leaves open: is THIS specific request
// actually still GENERATED (the /view beacon never landed), already FINALIZED-but-unsplit (should
// be showing up in findFinalizedNeedingSplit — check that script again if so), or already split
// (a buy_and_burn_log row exists)?
//
// Doesn't touch Blockscout/the chain at all — this is purely a DB read, same as
// markViewedAndFinalize/findFinalizedNeedingSplit themselves. If this shows the request is still
// GENERATED with first_viewed_at null, the split scheduler was never going to touch it regardless
// of Blockscout's own uptime — the "view" beacon (POST /pnl/statement/:requestId/view) is a pure DB
// write with no on-chain/Blockscout dependency in its own code path.
//
// Usage: node backend/scripts/checkStatementRequest.js <requestId | txHash>
import dotenv from "dotenv";
import { getById, getByTxHash } from "../db/statementRequests.js";
import { getPool } from "../db/pool.js";
import { query } from "../db/pool.js";

dotenv.config();

const input = process.argv[2];
if (!input) {
  console.error("Usage: node backend/scripts/checkStatementRequest.js <requestId | txHash>");
  process.exit(1);
}
if (!getPool()) {
  console.error("DATABASE_URL not set in this shell — can't check the live DB.");
  process.exit(1);
}

const isTxHash = /^0x[0-9a-fA-F]{64}$/.test(input.trim());

async function printRequest(r) {
  const burnLog = await query("SELECT * FROM buy_and_burn_log WHERE statement_request_id = $1", [r.id]);
  const burnRow = burnLog?.rows[0] || null;

  console.log(`\nRequest ${r.id}`);
  console.log(`  tracked_wallet:     ${r.tracked_wallet}`);
  console.log(`  payer_wallet:       ${r.payer_wallet}`);
  console.log(`  period:             ${r.period_type} / ${r.year}`);
  console.log(`  amount_paid_wei:    ${r.amount_paid_wei}`);
  console.log(`  status:             ${r.status}`);
  console.log(`  first_viewed_at:    ${r.first_viewed_at || "(never — the /view beacon has not landed)"}`);
  console.log(`  finalized_at:       ${r.finalized_at || "(not finalized yet)"}`);
  console.log(`  refunded_at:        ${r.refunded_at || "—"}`);

  if (r.status === "GENERATED" && !r.first_viewed_at) {
    console.log(`  ⚠️  Still GENERATED, never viewed — the split scheduler will never pick this up until`);
    console.log(`      either the /view beacon lands (customer opens "View / Download PDF" and the PDF`);
    console.log(`      fetch succeeds) or the 14-day auto-finalize job reaches it. This has nothing to do`);
    console.log(`      with Blockscout — markViewedAndFinalize is a pure DB write, no chain call at all.`);
  } else if (r.status === "FINALIZED" && !burnRow) {
    console.log(`  ⏳ FINALIZED, no buy_and_burn_log row yet — should be picked up by`);
    console.log(`      pnlSplitExecutionScheduler.js on its next 5-minute tick. If diagnoseSplitExecution.js`);
    console.log(`      showed 0 pending just now, either it split in between, or something's blocking the`);
    console.log(`      scheduler for this request specifically — re-run diagnoseSplitExecution.js.`);
  } else if (burnRow) {
    console.log(`  ✅ Already split — buy_and_burn_log row exists (tx ${burnRow.swap_and_burn_tx_hash}).`);
  } else if (r.status === "REFUNDED") {
    console.log(`  ℹ️  Refunded — never splits.`);
  }
}

async function main() {
  if (isTxHash) {
    const requests = await getByTxHash(input.trim());
    if (requests.length === 0) {
      console.log("No statement requests found for that transaction hash.");
      return;
    }
    for (const r of requests) await printRequest(r);
  } else {
    const request = await getById(input.trim());
    if (!request) {
      console.log("No statement request found for that ID.");
      return;
    }
    await printRequest(request);
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
