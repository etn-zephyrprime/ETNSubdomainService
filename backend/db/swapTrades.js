import { query } from "./pool.js";

const COLUMNS = [
  "tracked_wallet",
  "tx_hash",
  "log_index",
  "pool_address",
  "token_sold_address",
  "amount_sold",
  "token_bought_address",
  "amount_bought",
  "price_usd_sold_leg",
  "price_usd_bought_leg",
  "block_number",
  "timestamp",
];

function rowToValues(r) {
  return [
    r.trackedWallet.toLowerCase(),
    r.txHash,
    r.logIndex,
    r.poolAddress.toLowerCase(),
    r.tokenSoldAddress === "NATIVE" ? "NATIVE" : r.tokenSoldAddress.toLowerCase(),
    r.amountSold,
    r.tokenBoughtAddress === "NATIVE" ? "NATIVE" : r.tokenBoughtAddress.toLowerCase(),
    r.amountBought,
    r.priceUsdSoldLeg ?? null,
    r.priceUsdBoughtLeg ?? null,
    r.blockNumber,
    r.timestamp,
  ];
}

/** Each row: { trackedWallet, txHash, logIndex, poolAddress, tokenSoldAddress ('NATIVE' or
 * address), amountSold, tokenBoughtAddress, amountBought, priceUsdSoldLeg, priceUsdBoughtLeg,
 * blockNumber, timestamp }. Same dedup-and-skip semantics as insertTransfers. */
export async function insertSwapTrades(rows) {
  if (!rows.length) return;

  const values = [];
  const placeholders = rows.map((r) => {
    const rowValues = rowToValues(r);
    if (rowValues.length !== COLUMNS.length) {
      throw new Error(`insertSwapTrades: row produced ${rowValues.length} values, expected ${COLUMNS.length}`);
    }
    const tuple = rowValues.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    return `(${tuple.join(",")})`;
  });

  await query(
    `INSERT INTO swap_trades (${COLUMNS.map((c) => (c === "timestamp" ? '"timestamp"' : c)).join(",")})
     VALUES ${placeholders.join(",")}
     ON CONFLICT (tracked_wallet, tx_hash, log_index) DO NOTHING`,
    values
  );
}

export async function getSwapTradesInRange(trackedWallet, fromTs, toTs) {
  const res = await query(
    `SELECT * FROM swap_trades WHERE tracked_wallet = $1 AND "timestamp" >= $2 AND "timestamp" < $3
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), fromTs, toTs]
  );
  return res?.rows || [];
}

export async function getAllSwapTradesBefore(trackedWallet, beforeTs) {
  const res = await query(
    `SELECT * FROM swap_trades WHERE tracked_wallet = $1 AND "timestamp" < $2
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), beforeTs]
  );
  return res?.rows || [];
}
