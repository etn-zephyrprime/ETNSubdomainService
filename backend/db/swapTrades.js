import { query, chunkArray } from "./pool.js";

// Max rows per INSERT statement — see pool.js's own chunkArray comment (a real production crash
// in the sibling ingestedTransfers.js table, not a preemptive guess). 500 * COLUMNS.length (12) =
// 6,000 bound parameters, comfortably under the ~32,768 threshold that actually broke there.
const BATCH_SIZE = 500;

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

  for (const batch of chunkArray(rows, BATCH_SIZE)) {
    const values = [];
    const placeholders = batch.map((r) => {
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

/** Swap rows with at least one leg left unpriced (either leg independently — either a
 * deliberately-deferred non-priority asset or a genuine historical lookup failure). See
 * ingestedTransfers.js's getUnpricedTransfers for the same reasoning. */
export async function getSwapTradesWithUnpricedLegs(trackedWallet) {
  const res = await query(
    `SELECT id, token_sold_address, amount_sold, price_usd_sold_leg, token_bought_address, amount_bought, price_usd_bought_leg, "timestamp"
     FROM swap_trades
     WHERE tracked_wallet = $1 AND (price_usd_sold_leg IS NULL OR price_usd_bought_leg IS NULL)`,
    [trackedWallet.toLowerCase()]
  );
  return res?.rows || [];
}

/** Fills in both leg prices at once, in place — pass the row's EXISTING value for any leg that
 * was already priced (this doesn't merge/preserve on its own), never re-walks Blockscout. */
export async function setSwapLegPrices(id, priceUsdSoldLeg, priceUsdBoughtLeg) {
  await query(`UPDATE swap_trades SET price_usd_sold_leg = $2, price_usd_bought_leg = $3 WHERE id = $1`, [
    id,
    priceUsdSoldLeg,
    priceUsdBoughtLeg,
  ]);
}
