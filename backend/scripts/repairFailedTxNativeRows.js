// backend/scripts/repairFailedTxNativeRows.js
//
// One-time repair for the failed-transaction bug (see isFailedTransaction in pnlIngestion.js):
// ingestion used to book a REVERTED transaction's `value` as ETN leaving the wallet, though a failed
// tx moves nothing (only its gas is spent). Real example: two reverted `activateDomain` calls carrying
// ~305k ETN each were recorded as 611,050 ETN of outflows the wallet never made — the entire
// ledger-vs-on-chain ETN shortfall (and the "FIFO shortfall" warnings that came with it) on the
// owner wallet.
//
// The fix in pnlIngestion.js only stops NEW ingestion from doing this; the rows already in
// ingested_transfers stay wrong. This deletes exactly those rows — the plain native-value row
// (log_index -2) of every transaction Blockscout reports as failed — and nothing else. Gas rows
// (log_index -1) are untouched: a failed tx really did burn its gas. No re-ingestion is needed: the
// ledger is rebuilt from ingested_transfers on every read, so it's correct as soon as the rows go.
//
// It also clears pnl_snapshots for each repaired wallet (unless --keep-history): those daily rows were
// computed from the wrong ledger, and the scheduler's backfill only fills MISSING days, so leaving them
// would freeze the understated values into "Value Over Time". They regenerate on the next scheduler run.
//
// DRY RUN BY DEFAULT — this deletes ledger rows.
//   node backend/scripts/repairFailedTxNativeRows.js                       # report what would be deleted
//   node backend/scripts/repairFailedTxNativeRows.js --apply               # delete + clear history
//   node backend/scripts/repairFailedTxNativeRows.js --apply --keep-history
//   node backend/scripts/repairFailedTxNativeRows.js --wallet=0xabc...     # just one wallet
//
// Safe to re-run: once the rows are gone there's nothing left to match.
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool, query } from "../db/pool.js";

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepHistory = args.includes("--keep-history");
const walletArg = args.find((a) => a.startsWith("--wallet="))?.slice("--wallet=".length).toLowerCase();
const BLOCKSCOUT = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;

async function getJson(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BLOCKSCOUT}${path}`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
    } catch {
      // retry below
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`Blockscout request failed after retries: ${path}`);
}

/** Every failed transaction of `wallet` that carried value, as a Set of lowercased hashes. */
async function getFailedValueTxHashes(wallet) {
  const failed = new Set();
  let extra = "";
  for (let page = 0; page < 1000; page++) {
    const res = await getJson(`/addresses/${wallet}/transactions${extra}`);
    for (const tx of res.items || []) {
      const isFailed = tx.status === "error" || (typeof tx.result === "string" && tx.result !== "success");
      if (isFailed && BigInt(tx.value || "0") > 0n) failed.add(String(tx.hash).toLowerCase());
    }
    if (!res.next_page_params) break;
    extra = `?${new URLSearchParams(Object.fromEntries(Object.entries(res.next_page_params).map(([k, v]) => [k, String(v)])))}`;
    await new Promise((r) => setTimeout(r, 150));
  }
  return failed;
}

async function main() {
  if (!getPool()) throw new Error("DATABASE_URL not set — nothing to repair.");

  const res = await query(
    `SELECT DISTINCT tracked_wallet FROM ingested_transfers WHERE asset_type = 'native' AND log_index = -2`
  );
  let wallets = (res?.rows || []).map((r) => String(r.tracked_wallet).toLowerCase());
  if (walletArg) {
    if (!ethers.isAddress(walletArg)) throw new Error(`--wallet is not a valid address: ${walletArg}`);
    wallets = wallets.filter((w) => w === walletArg);
  }
  if (wallets.length === 0) {
    console.log("No matching wallets with native value rows — nothing to repair.");
    await getPool().end();
    return;
  }

  console.log(`${apply ? "Repairing" : "Checking"} ${wallets.length} wallet(s)...\n`);
  let totalRows = 0;
  let totalEtn = 0;
  let repaired = 0;

  for (const wallet of wallets) {
    let failedHashes;
    try {
      failedHashes = await getFailedValueTxHashes(wallet);
    } catch (err) {
      console.log(`${wallet}  ⚠️  skipped — couldn't walk its transactions: ${err.message}`);
      continue;
    }
    if (failedHashes.size === 0) continue;

    const rows = await query(
      `SELECT id, tx_hash, direction, amount_decimal FROM ingested_transfers
       WHERE tracked_wallet = $1 AND asset_type = 'native' AND log_index = -2 AND lower(tx_hash) = ANY($2::text[])`,
      [wallet, [...failedHashes]]
    );
    const bad = rows?.rows || [];
    if (bad.length === 0) continue;

    const etn = bad.reduce((sum, r) => sum + Number(r.amount_decimal), 0);
    console.log(`${wallet}  ${bad.length} row(s) from failed transactions, ${etn.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN`);
    for (const r of bad) console.log(`    ${r.direction.padEnd(4)} ${Number(r.amount_decimal).toLocaleString(undefined, { maximumFractionDigits: 2 }).padStart(16)} ETN  ${String(r.tx_hash).slice(0, 18)}…`);
    totalRows += bad.length;
    totalEtn += etn;

    if (apply) {
      await query(`DELETE FROM ingested_transfers WHERE id = ANY($1::bigint[])`, [bad.map((r) => r.id)]);
      if (!keepHistory) await query(`DELETE FROM pnl_snapshots WHERE wallet_address = $1`, [wallet]);
      repaired++;
    }
  }

  console.log(
    `\n${apply ? "Deleted" : "Would delete"} ${totalRows} row(s) (${totalEtn.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN of phantom transfers) across ${apply ? repaired : "the wallets above"}.`
  );
  if (!apply) console.log("Dry run — no changes made. Re-run with --apply to delete them.");
  else if (!keepHistory) console.log("pnl_snapshots cleared for the repaired wallets; the daily scheduler will regenerate their history.");
  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
