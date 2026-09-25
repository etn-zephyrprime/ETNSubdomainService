// backend/scripts/runCexBalanceHistory.js
//
// Manually triggers one real refresh of cexBalanceHistory.js's published R2 snapshot — the same
// function the background scheduler calls every 24h (plus once on backend startup). Useful right
// after adding a new address via addCexAddress.js: rather than waiting up to 24h for the next
// scheduled cycle, or a redeploy to get the immediate startup run, this runs it right now and prints
// exactly what happened.
//
// Usage:
//   node backend/scripts/runCexBalanceHistory.js
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { refreshAndPublish } from "../utils/cexBalanceHistory.js";

dotenv.config();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do.");
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 isn't configured in this environment (R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) — refreshAndPublish would silently no-op on the publish step.");
  }

  console.log("Running a real CEX balance history refresh — this re-walks every known address's full balance ledger, may take a moment...");
  await refreshAndPublish();
  console.log("Done — see the log line above for how many addresses succeeded. Check the CEX Balances tab in a few seconds (the R2 proxy caches for 60s).");
  await getPool().end();
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exitCode = 1;
});
