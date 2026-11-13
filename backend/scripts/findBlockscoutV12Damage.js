// backend/scripts/findBlockscoutV12Damage.js
//
// Read-only. Finds PnL ledgers damaged while Electroneum's explorer ran Blockscout v12 before
// PR #502's normalizer deployed (token objects had `address_hash`, our code read `address`):
//
//   DEFINITE  ingested_transfers token rows (erc20/721/1155) with no token_address: the transfer
//             was stored as an unknown asset and the cursor moved past it.
//   FAILED    wallets whose latest ingest job FAILED since the cutoff (e.g. a swap leg with no
//             token address hitting swap_trades' NOT NULL): nothing advanced, they recover on
//             their own, listed for visibility only.
//   POSSIBLE  wallets whose ingestion cursor advanced since the cutoff with no definite damage:
//             a swap whose token legs were dropped leaves no trace in the tables, so these are
//             only caught by a drift check.
//
// Usage (Render shell):
//   node scripts/findBlockscoutV12Damage.js                       # cutoff 2026-11-10T00:00Z
//   node scripts/findBlockscoutV12Damage.js --since 2026-11-11    # custom cutoff (UTC)
//   node scripts/findBlockscoutV12Damage.js --drift               # also run diagnoseLedgerDrift.js per affected wallet
//
// Repair: it prints the resetDefiAffectedWallets.js command for the affected wallets (full
// checkpointed reset + re-ingest; dry run unless --apply).
import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query, getPool } from "../db/pool.js";

dotenv.config();

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = new Date(sinceIdx >= 0 ? args[sinceIdx + 1] : "2026-11-10T00:00:00Z");
if (Number.isNaN(since.getTime())) throw new Error("--since needs a date, e.g. 2026-11-11");
const runDrift = args.includes("--drift");

const rows = async (sql, params) => (await query(sql, params))?.rows || [];

const definite = await rows(
  `SELECT tracked_wallet, count(*)::int AS bad_rows, min("timestamp") AS first_at, max("timestamp") AS last_at, min(block_number) AS first_block
     FROM ingested_transfers
    WHERE asset_type <> 'native' AND (token_address IS NULL OR token_address IN ('', 'undefined', 'null'))
    GROUP BY tracked_wallet ORDER BY bad_rows DESC`
);
const failed = await rows(
  `SELECT tracked_wallet, updated_at, left(error_message, 160) AS error
     FROM wallet_ingestion_jobs WHERE status = 'FAILED' AND updated_at >= $1 ORDER BY updated_at DESC`,
  [since]
);
const advanced = await rows(
  `SELECT tracked_wallet, last_ingested_block, updated_at FROM wallet_ingestion_state WHERE updated_at >= $1 ORDER BY updated_at`,
  [since]
);

const definiteSet = new Set(definite.map((r) => r.tracked_wallet));
const possible = advanced.filter((r) => !definiteSet.has(r.tracked_wallet));
const iso = (d) => (d ? new Date(d).toISOString().replace(".000Z", "Z") : "-");

console.log(`Blockscout v12 damage scan (cutoff ${iso(since)})\n`);
console.log(`DEFINITE: ${definite.length} wallet(s) with token rows missing their token address`);
for (const r of definite) console.log(`  ${r.tracked_wallet}  ${r.bad_rows} row(s)  ${iso(r.first_at)} → ${iso(r.last_at)}  (from block ${r.first_block})`);
console.log(`\nFAILED since cutoff: ${failed.length} wallet(s) (no data written; retries on its own)`);
for (const r of failed) console.log(`  ${r.tracked_wallet}  ${iso(r.updated_at)}  ${r.error}`);
console.log(`\nPOSSIBLE: ${possible.length} wallet(s) ingested since cutoff with no definite damage (dropped swap legs leave no trace)`);
for (const r of possible) console.log(`  ${r.tracked_wallet}  cursor ${r.last_ingested_block}  ${iso(r.updated_at)}`);

const affected = [...definiteSet, ...possible.map((r) => r.tracked_wallet)];
if (runDrift && affected.length) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "diagnoseLedgerDrift.js");
  for (const w of affected) {
    console.log(`\n===== diagnoseLedgerDrift ${w} =====`);
    try {
      process.stdout.write(execFileSync(process.execPath, [script, w], { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      console.log(`  drift diagnostic failed: ${err.message.split("\n")[0]}`);
    }
  }
}

if (definite.length) {
  console.log(`\nRepair the definite set (dry run first, then add --apply):`);
  console.log(`  node scripts/resetDefiAffectedWallets.js ${[...definiteSet].join(" ")}`);
}
if (possible.length) {
  console.log(`\nPOSSIBLE wallets: re-ingest is cheap and idempotent, so they can be reset too:`);
  console.log(`  node scripts/resetDefiAffectedWallets.js ${possible.map((r) => r.tracked_wallet).join(" ")}`);
}
if (!definite.length && !possible.length) console.log("\nNothing to repair.");

await getPool().end().catch(() => {});
process.exit(0);
