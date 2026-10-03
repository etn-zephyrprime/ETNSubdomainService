// backend/scripts/findStaleBackfills.js
//
// Answers "does any other token have the same stuck-backfill bug CLUB had?" with real data
// instead of a guess. CLUB's price_history_backfill_state row had this exact contradictory shape:
// pool_count > 0 (a real pool WAS found) but earliest_available_date IS NULL (zero days of price
// data were ever actually saved from it) — see pnlPricing.js's ensureBackfilled for the full
// explanation and the self-heal fix (confirmed live: CLUB's own stuck record, caused by a
// GeckoTerminal rate limit during its one-time backfill, is exactly this shape).
//
// This just lists every row currently matching that signature — ensureBackfilled's self-heal
// (PRs #379/#380) already fixes each one automatically the next time that token's price is looked
// up, so this script doesn't change anything, it only tells you the current scope: how many
// tokens are affected right now, and (via --backfill) can proactively re-trigger that self-heal for
// every one of them at once instead of waiting for them to come up individually in a wallet's PnL.
//
// Usage:
//   node backend/scripts/findStaleBackfills.js             # just list affected tokens
//   node backend/scripts/findStaleBackfills.js --backfill  # also retry each one now
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";
import { getHistoricalPriceUsd } from "../services/pnlPricing.js";

dotenv.config();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to check.");
  }

  const res = await query(
    `SELECT asset, pool_count, backfilled_at FROM price_history_backfill_state
     WHERE pool_count > 0 AND earliest_available_date IS NULL
     ORDER BY backfilled_at ASC`
  );
  const rows = res?.rows || [];

  if (rows.length === 0) {
    console.log("None found — no other token currently has CLUB's stuck-backfill signature.");
    await getPool().end();
    return;
  }

  console.log(`${rows.length} token(s) with the same stuck-backfill signature CLUB had:\n`);
  for (const row of rows) {
    console.log(`  ${row.asset}  (pool_count=${row.pool_count}, recorded ${new Date(row.backfilled_at).toISOString()})`);
  }

  if (process.argv.includes("--backfill")) {
    console.log("\nRetrying each one now (same self-heal the next real price lookup would trigger)...");
    for (const row of rows) {
      try {
        // Today's date is enough to trigger ensureBackfilled's self-heal check for this asset —
        // the actual date passed doesn't matter, only that a lookup happens at all.
        const price = await getHistoricalPriceUsd(row.asset, new Date());
        console.log(`  ✅ ${row.asset} — resolved $${price}`);
      } catch (err) {
        console.log(`  ⚠️  ${row.asset} — still failing: ${err.message}`);
      }
    }
  } else {
    console.log("\nRun with --backfill to retry each one now, or leave them — they'll self-heal the next time that token's price is actually looked up.");
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Stale-backfill scan failed:", err.message);
  process.exitCode = 1;
});
