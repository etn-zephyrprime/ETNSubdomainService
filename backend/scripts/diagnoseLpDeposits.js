// backend/scripts/diagnoseLpDeposits.js
//
// Read-only. Why a V2 LP position's "deposited" baseline (getV2LpDepositedQuantities) looks wrong —
// e.g. one side reading 0, which leaves its impermanent loss blank. Lists every recorded add/remove
// leg for the pool (the synthetic liquidity rows, log_index -2000..-3999), every LP-token movement,
// and the wallet's earliest ingested row, so you can tell "added before ingestion began" from "a leg
// was never recorded".
//
// Usage (from backend/):
//   node scripts/diagnoseLpDeposits.js <wallet> <pairAddress>
import dotenv from "dotenv";
import { getPool, query } from "../db/pool.js";
import { getV2LpDepositedQuantities } from "../db/ingestedTransfers.js";
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";

dotenv.config();

const [walletArg, pairArg] = process.argv.slice(2);

async function main() {
  if (!walletArg || !pairArg) throw new Error("Usage: node scripts/diagnoseLpDeposits.js <wallet> <pairAddress>");
  if (!getPool()) throw new Error("DATABASE_URL not set.");
  const wallet = walletArg.toLowerCase();
  const pair = pairArg.toLowerCase();

  const first = await query(`SELECT MIN("timestamp") AS t, COUNT(*) AS n FROM ingested_transfers WHERE tracked_wallet = $1`, [wallet]);
  console.log(`Wallet ${wallet}: ${first.rows[0].n} ingested rows, earliest ${first.rows[0].t?.toISOString?.() ?? first.rows[0].t}`);

  const legs = await query(
    `SELECT "timestamp", tx_hash, direction, asset_type, token_address, amount_decimal, log_index
     FROM ingested_transfers
     WHERE tracked_wallet = $1 AND counterparty_address = $2 AND log_index <= -2000 AND log_index > -4000
     ORDER BY "timestamp"`,
    [wallet, pair]
  );
  console.log(`\nLiquidity add/remove legs recorded against the pool (${legs.rows.length}):`);
  for (const r of legs.rows) {
    console.log(`  ${new Date(r.timestamp).toISOString().slice(0, 16)}  ${r.direction === "out" ? "ADD   " : "REMOVE"}  ${r.asset_type.padEnd(6)} ${String(r.token_address || "ETN").padEnd(42)} ${r.amount_decimal}  (tx ${r.tx_hash.slice(0, 12)}…, log ${r.log_index})`);
  }

  const lp = await query(
    `SELECT "timestamp", tx_hash, direction, counterparty_address, amount_decimal, log_index
     FROM ingested_transfers
     WHERE tracked_wallet = $1 AND token_address = $2
     ORDER BY "timestamp"`,
    [wallet, pair]
  );
  console.log(`\nLP token movements (${lp.rows.length}):`);
  for (const r of lp.rows) {
    console.log(`  ${new Date(r.timestamp).toISOString().slice(0, 16)}  ${r.direction.padEnd(3)} ${r.amount_decimal.toString().padStart(28)}  ${r.direction === "in" ? "from" : "to  "} ${r.counterparty_address}  (tx ${r.tx_hash.slice(0, 12)}…)`);
  }

  // The tx's native ETN rows, for adds whose ETN leg might be missing (addLiquidityETN).
  const lpTxs = [...new Set(lp.rows.map((r) => r.tx_hash))];
  if (lpTxs.length) {
    const native = await query(
      `SELECT tx_hash, direction, counterparty_address, amount_decimal, log_index
       FROM ingested_transfers WHERE tracked_wallet = $1 AND asset_type = 'native' AND tx_hash = ANY($2::text[])`,
      [wallet, lpTxs]
    );
    console.log(`\nNative ETN rows in those same txs (${native.rows.length}):`);
    for (const r of native.rows) console.log(`  tx ${r.tx_hash.slice(0, 12)}…  ${r.direction} ${r.amount_decimal} ETN  ${r.direction === "in" ? "from" : "to"} ${r.counterparty_address}  (log ${r.log_index})`);
  }

  const pairContract = new ethers.Contract(pair, ["function token0() view returns (address)", "function token1() view returns (address)"], createRpcProvider());
  try {
    const [t0, t1] = await Promise.all([pairContract.token0(), pairContract.token1()]);
    const { net0, net1 } = await getV2LpDepositedQuantities(wallet, pair, t0, t1);
    console.log(`\ngetV2LpDepositedQuantities → token0 ${t0}: ${net0} raw, token1 ${t1}: ${net1} raw`);
  } catch (err) {
    console.log(`\n(couldn't read the pair's tokens for the baseline line: ${err.message})`);
  }
  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Diagnostic failed:", err.message);
  process.exitCode = 1;
});
