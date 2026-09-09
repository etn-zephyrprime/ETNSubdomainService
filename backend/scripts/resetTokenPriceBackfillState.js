// backend/scripts/resetTokenPriceBackfillState.js
//
// One-time manual trigger after the ElectroSwap-candles PnL pricing integration
// (pnlPricing.js's ensureBackfilled) shipped: that function runs its bulk historical backfill
// EXACTLY ONCE, EVER, per asset, short-circuiting on price_history_backfill_state having a row at
// all — so any token already backfilled before that integration landed will keep serving its old
// GeckoTerminal-only result (hard-capped at ~184 days regardless of pool age) FOREVER, never
// automatically retrying with ElectroSwap now tried first. Deleting an asset's state row here is
// what lets the next getHistoricalPriceUsd/backfillPnlHistory call for it re-trigger a fresh bulk
// backfill that actually gets to try ElectroSwap.
//
// Safe to run: this only clears the "have we ever bulk-backfilled this asset" MARKER, never
// price_points itself — upsertPricePoint is a non-destructive UPSERT (ON CONFLICT ... DO UPDATE),
// so a re-triggered backfill only adds/overwrites the days its source actually has data for; no
// previously-cached day is deleted out from under a statement that reads it before the re-backfill
// completes. Worst case for a date the fresh backfill doesn't happen to re-find (e.g. a transient
// source failure) is the SAME "unresolvable price" handling getHistoricalPriceUsd already has for
// any never-backfilled asset — not new data loss.
//
// ETN is deliberately excluded (and can't be targeted) — its primary source, KuCoin's full
// 2019-forward history, is untouched by the ElectroSwap change; ElectroSwap is only ETN's
// second-line fallback (if KuCoin's own history ever comes back empty), so resetting ETN's state
// would just reproduce the exact same KuCoin result at the cost of a real re-fetch.
//
// DRY RUN BY DEFAULT — this is a production PnL Statement pricing cache, so it only lists what
// WOULD be reset unless told to actually do it:
//   node backend/scripts/resetTokenPriceBackfillState.js                 # list every backfilled
//                                                                          # non-ETN asset (dry run)
//   node backend/scripts/resetTokenPriceBackfillState.js --apply         # actually clear all of them
//   node backend/scripts/resetTokenPriceBackfillState.js 0xabc...        # just that token (dry run)
//   node backend/scripts/resetTokenPriceBackfillState.js 0xabc... --apply
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyAsset = args.find((a) => !a.startsWith("--"))?.toLowerCase();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to reset.");
  }

  const rows = onlyAsset
    ? (await query("SELECT * FROM price_history_backfill_state WHERE asset = $1 AND asset != 'ETN'", [onlyAsset]))?.rows || []
    : (await query("SELECT * FROM price_history_backfill_state WHERE asset != 'ETN' ORDER BY asset"))?.rows || [];

  if (rows.length === 0) {
    console.log(onlyAsset ? `${onlyAsset} has no backfill state recorded — nothing to reset.` : "No non-ETN assets have any backfill state recorded — nothing to reset.");
    await getPool().end();
    return;
  }

  console.log(`${apply ? "Resetting" : "Would reset"} ${rows.length} asset(s):\n`);
  for (const row of rows) {
    const earliest = row.earliest_available_date ? new Date(row.earliest_available_date).toISOString().slice(0, 10) : "none found";
    console.log(`  ${row.asset}  (was: earliest=${earliest}, pool_count=${row.pool_count}, backfilled_at=${new Date(row.backfilled_at).toISOString()})`);
  }

  if (!apply) {
    console.log(`\nDry run — no changes made. Re-run with --apply to actually clear ${onlyAsset ? "this" : "these"} row(s).`);
    console.log("Each cleared asset re-backfills (trying ElectroSwap first) the next time its price is needed — a PnL Statement generation/regeneration, or the next backfillPnlHistory.js run.");
    await getPool().end();
    return;
  }

  const assets = rows.map((r) => r.asset);
  await query("DELETE FROM price_history_backfill_state WHERE asset = ANY($1::text[])", [assets]);
  console.log(`\nDone — cleared ${assets.length} asset(s). Existing cached price_points were NOT touched, only the backfill marker.`);

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Reset failed:", err.message);
  process.exitCode = 1;
});
