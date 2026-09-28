// backend/scripts/fixCoreDeadAddressBurns.js
//
// One-off top-up for CORE's burn history, needed exactly once after tokenBurnService.js's
// burnTargetAddresses started aggregating BOTH of CORE's real burn mechanisms (Transfers to the
// true zero address via burn(), AND — confirmed live — some CORE sent directly to the conventional
// dead address too) instead of only the zero address. Whatever block range CORE's cursor already
// covers was scanned before that change, with the old zero-address-only filter, so any historical
// dead-address burns inside that already-scanned window were never recorded. This re-scans ONLY the
// dead-address leg across exactly that window and inserts whatever it finds — it does not touch
// already-recorded zero-address burns, and does not change scan progress (the cursor is untouched).
//
// Blocks outside that window don't need this: anything CORE's cursor hasn't reached yet (older
// blocks still pending backward backfill, newer ones still pending forward catch-up) gets scanned
// with the new combined filter automatically, the normal way — via page views or
// backfillTokenBurns.js.
//
// Usage:
//   node backend/scripts/fixCoreDeadAddressBurns.js
//
// Safe to re-run: inserts are deduped by (token_address, tx_hash, log_index), so a repeat run just
// finds 0 new rows.
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { backfillCoreDeadAddressGap } from "../services/tokenBurnService.js";

dotenv.config();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do (token_burn_cursor/token_burn_events live in Postgres).");
  }

  console.log("Checking CORE's already-scanned block range for dead-address burns the old zero-address-only scan missed...");
  let lastPrint = 0;
  const result = await backfillCoreDeadAddressGap({
    onProgress: (p) => {
      if (p.phase !== "logs") return;
      const now = Date.now();
      if (now - lastPrint < 5000) return;
      lastPrint = now;
      console.log(`  scanning — block ${p.scannedTo.toLocaleString()} (chunk ${p.rangeStart.toLocaleString()}-${p.rangeEnd.toLocaleString()}), ${p.foundSoFar} found in this chunk so far`);
    },
  });

  if (!result.scanned) {
    console.log(result.reason);
  } else {
    console.log(
      `Done — checked ${result.blocksCovered.toLocaleString()} block(s) (${result.rangeStart.toLocaleString()}-${result.rangeEnd.toLocaleString()}), found ${result.inserted} new dead-address burn event(s) for CORE.`
    );
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("CORE dead-address top-up failed:", err);
  process.exit(1);
});
