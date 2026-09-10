// backend/scripts/generateDemoSnapshot.js
//
// Computes the Core Tier demo's PnL/DeFi/LP/NFT/holdings data for its 3 fixed wallets (see
// coreTierDemoRouter.js's own DEMO_WALLET_ADDRESSES comment), anonymizes it (scales every USD/
// quantity/balance figure to ANONYMIZATION_FACTOR of the real number — see anonymizeDemoData), and
// persists the result to R2 so the live route just serves it instead of recomputing on every cache
// miss. See coreTierDemoState.js's own header comment for why this moved off the request path
// entirely: the live computation is a real cost (FIFO replay + live pricing + DeFi/LP/NFT
// valuation, for 3 wallets, 365 days of history) that used to regularly time out the request.
//
// Not on any scheduler — the demo's data doesn't need to track the real wallets' activity in real
// time (it's a preview, not a live account), so this is meant to be re-run manually, occasionally,
// whenever a fresher-looking demo is wanted. Safe to re-run any time: it fully recomputes and
// overwrites the stored snapshot, it doesn't append to it.
//
// Usage:
//   node backend/scripts/generateDemoSnapshot.js
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { computeDemoData, anonymizeDemoData } from "../utils/coreTierDemoRouter.js";
import { setDemoSnapshot } from "../state/coreTierDemoState.js";

dotenv.config();

async function main() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY not set — nowhere to persist the snapshot.");
  }

  console.log("Computing Core Tier demo data (PnL, DeFi, liquidity, NFT PnL, holdings) for all 3 demo wallets...");
  const data = await computeDemoData();

  console.log("Anonymizing (scaling every USD/quantity/balance figure)...");
  const anonymized = anonymizeDemoData(data);

  console.log("Persisting to R2...");
  await setDemoSnapshot(anonymized);

  console.log("✅ Demo snapshot generated and stored — the live route will serve it on the next request.");

  if (getPool()) await getPool().end();
}

main().catch((err) => {
  console.error("❌ Demo snapshot generation failed:", err);
  process.exitCode = 1;
});
