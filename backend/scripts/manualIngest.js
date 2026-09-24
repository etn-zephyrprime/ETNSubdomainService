// backend/scripts/manualIngest.js
//
// Manually kicks off a full ingestWalletHistory run (both the three Blockscout REST walks and the
// DeFi log scan) for one wallet — the exact same function checkAndStartIngestIfNeeded/
// computeLivePnlSnapshot call automatically on a member's own reconnect, just triggered directly
// here instead of waiting on the customer to reload a page. Not destructive: purely additive
// (walks history, inserts rows with ON CONFLICT DO NOTHING, advances a cursor) — safe to run
// against a wallet that's already mid-ingest or already fully caught up either way.
//
// Usage: node scripts/manualIngest.js <trackedWalletAddress> [selfOwnedAddress1] [selfOwnedAddress2] ...
//
// selfOwnedAddresses are optional — omitting them just means this run won't exclude self-transfers
// to/from the member's OTHER tracked wallets from realized PnL; harmless for just getting a wallet
// caught up, only cosmetic for that one run's own figures.
import dotenv from "dotenv";
dotenv.config();

import { ingestWalletHistory } from "../services/pnlIngestion.js";
import { getPool } from "../db/pool.js";

const [, , trackedWallet, ...selfOwnedAddresses] = process.argv;
if (!trackedWallet) {
  console.error("Usage: node scripts/manualIngest.js <trackedWalletAddress> [selfOwnedAddress1] [selfOwnedAddress2] ...");
  process.exit(1);
}
if (!getPool()) {
  console.error("DATABASE_URL not set in this shell — can't ingest against the live DB.");
  process.exit(1);
}

console.log(
  `Starting full ingestion for ${trackedWallet}${selfOwnedAddresses.length ? ` (self-owned: ${selfOwnedAddresses.join(", ")})` : ""}...`
);
const startedAt = Date.now();

try {
  await ingestWalletHistory(trackedWallet, selfOwnedAddresses, null);
  console.log(`✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
} catch (err) {
  console.error("❌ Ingestion failed:", err.message);
  process.exit(1);
}
