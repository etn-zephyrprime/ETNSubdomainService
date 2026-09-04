// backend/scripts/regenerateStatement.js
//
// Re-runs generation for a statement request stuck in PENDING_GENERATION -- e.g. a deploy/restart
// interrupted it mid-generation, before it ever reached markGenerated(). Safe to re-run:
// generateStatement() re-derives everything from scratch (re-ingests wallet history, re-replays
// FIFO, etc.) with no dependency on any state left over from an incomplete prior run; the R2 keys
// it writes to are deterministic (pnl-statements/<wallet>/<requestId>.{json,pdf}), so a second run
// just overwrites them cleanly; and markGenerated() only succeeds `WHERE status =
// 'PENDING_GENERATION'`, so this can't double-apply to a request that actually did finish.
//
// Usage:
//   node scripts/regenerateStatement.js                # no id given -- lists every currently
//                                                        # PENDING_GENERATION request, does nothing
//   node scripts/regenerateStatement.js <requestId>     # regenerates that one
import { generateStatement } from "../services/pnlStatementGenerator.js";
import { getById } from "../db/statementRequests.js";
import { query } from "../db/pool.js";

const requestId = process.argv[2];

async function listStuck() {
  const res = await query(
    `SELECT id, tracked_wallet, payer_wallet, period_type, year, updated_at
     FROM statement_requests
     WHERE status = 'PENDING_GENERATION'
     ORDER BY updated_at ASC`
  );
  const rows = res?.rows || [];

  if (rows.length === 0) {
    console.log("No requests currently stuck in PENDING_GENERATION.");
    return;
  }

  console.log(`${rows.length} request(s) in PENDING_GENERATION:\n`);
  for (const r of rows) {
    console.log(`${r.id}  wallet=${r.tracked_wallet}  ${r.period_type} ${r.year}  last updated ${r.updated_at}`);
  }
  console.log("\nRe-run with one of the IDs above to regenerate it:");
  console.log("  node scripts/regenerateStatement.js <requestId>");
}

async function regenerate(id) {
  const request = await getById(id);
  if (!request) {
    console.error(`No statement request found with id ${id}`);
    process.exit(1);
  }

  console.log(`Found request ${id}: wallet=${request.tracked_wallet} period=${request.period_type} ${request.year} status=${request.status}`);

  if (request.status !== "PENDING_GENERATION") {
    console.error(`Refusing to run: status is ${request.status}, not PENDING_GENERATION — generateStatement() itself would also refuse this.`);
    process.exit(1);
  }

  console.log("Regenerating (a wallet with a lot of history can take a while)...");
  const updated = await generateStatement(id);
  console.log(`Done — status is now ${updated.status}.`);
  console.log(`PDF:  ${updated.artifact_pdf_key}`);
  console.log(`JSON: ${updated.artifact_json_key}`);
}

if (!requestId) {
  await listStuck();
} else {
  await regenerate(requestId);
}
