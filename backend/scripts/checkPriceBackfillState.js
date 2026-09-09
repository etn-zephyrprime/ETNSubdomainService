// backend/scripts/checkPriceBackfillState.js
//
// Read-only visibility into price_history_backfill_state (see pnlPricing.js's ensureBackfilled) —
// built alongside resetTokenPriceBackfillState.js so there's an easy way to see which assets have
// (re-)backfilled since a reset, and — per asset — which SOURCE actually contributed which cached
// days now that GeckoTerminal and ElectroSwap are merged together (mergeBackfillResults) rather
// than one simply replacing the other.
//
// Usage:
//   node backend/scripts/checkPriceBackfillState.js                # every asset with backfill state,
//                                                                    # most-recently-backfilled first
//   node backend/scripts/checkPriceBackfillState.js <asset>         # one asset's state, plus its
//                                                                    # price_points broken down by
//                                                                    # source (kucoin / geckoterminal-
//                                                                    # backfill / electroswap-backfill)
//   node backend/scripts/checkPriceBackfillState.js ETN             # 'ETN' works too (native asset's
//                                                                    # own cache key)
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";

dotenv.config();

const requested = process.argv[2]?.trim();
const onlyAsset = requested && requested.toUpperCase() !== "ETN" ? requested.toLowerCase() : requested?.toUpperCase();

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : "none found";
}

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to check.");
  }

  if (!onlyAsset) {
    const res = await query("SELECT * FROM price_history_backfill_state ORDER BY backfilled_at DESC");
    const rows = res?.rows || [];
    if (rows.length === 0) {
      console.log("No assets have any backfill state recorded yet.");
    } else {
      console.log(`${rows.length} asset(s) backfilled:\n`);
      for (const row of rows) {
        console.log(
          `  ${row.asset.padEnd(44)} earliest=${fmtDate(row.earliest_available_date).padEnd(12)} pool_count=${String(row.pool_count).padEnd(4)} backfilled_at=${new Date(row.backfilled_at).toISOString()}`
        );
      }
    }
    console.log(`\nFor a source-by-source breakdown of one asset's cached prices, run:\n  node backend/scripts/checkPriceBackfillState.js <asset address or ETN>`);
    await getPool().end();
    return;
  }

  const stateRes = await query("SELECT * FROM price_history_backfill_state WHERE asset = $1", [onlyAsset]);
  const state = stateRes?.rows[0];
  if (!state) {
    console.log(`${onlyAsset} has no backfill state recorded — hasn't been bulk-backfilled yet (or was reset and hasn't been needed again since).`);
    await getPool().end();
    return;
  }

  console.log(`${onlyAsset}`);
  console.log(`  earliest_available_date: ${fmtDate(state.earliest_available_date)}`);
  console.log(`  pool_count (sources scanned across GeckoTerminal + ElectroSwap): ${state.pool_count}`);
  console.log(`  backfilled_at: ${new Date(state.backfilled_at).toISOString()}`);

  const breakdownRes = await query(
    `SELECT source, COUNT(*) AS days, MIN("timestamp") AS earliest, MAX("timestamp") AS latest
     FROM price_points WHERE asset = $1 GROUP BY source ORDER BY earliest ASC`,
    [onlyAsset]
  );
  const breakdown = breakdownRes?.rows || [];
  if (breakdown.length === 0) {
    console.log("\n  No price_points cached for this asset (backfill found no data).");
  } else {
    console.log(`\n  price_points by source:`);
    for (const row of breakdown) {
      console.log(`    ${row.source.padEnd(24)} ${String(row.days).padStart(4)} day(s)   ${fmtDate(row.earliest)} → ${fmtDate(row.latest)}`);
    }
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Check failed:", err.message);
  process.exitCode = 1;
});
