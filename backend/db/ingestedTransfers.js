import { query } from "./pool.js";

// Raw per-wallet transfer history — dedup key (tracked_wallet, tx_hash, log_index) mirrors
// nftSalesCache.js's composite-key pattern. log_index is -1 for a plain top-level/internal native
// transfer, which has no log of its own.

const COLUMNS = [
  "tracked_wallet",
  "tx_hash",
  "log_index",
  "direction",
  "counterparty_address",
  "is_self_transfer",
  "is_cex",
  "asset_type",
  "token_address",
  "amount_raw",
  "amount_decimal",
  "price_usd_at_time",
  "usd_value",
  "gas_fee_wei",
  "block_number",
  "timestamp",
];

function rowToValues(r) {
  // Order must match COLUMNS exactly — kept as one array literal (not spread field-by-field)
  // specifically so a reviewer can diff this against COLUMNS above line-for-line.
  return [
    r.trackedWallet.toLowerCase(),
    r.txHash,
    r.logIndex,
    r.direction,
    r.counterpartyAddress.toLowerCase(),
    r.isSelfTransfer,
    r.isCex,
    r.assetType,
    r.tokenAddress ? r.tokenAddress.toLowerCase() : null,
    r.amountRaw.toString(),
    r.amountDecimal,
    r.priceUsdAtTime ?? null,
    r.usdValue ?? null,
    r.gasFeeWei != null ? r.gasFeeWei.toString() : null,
    r.blockNumber,
    r.timestamp,
  ];
}

/** Bulk-inserts rows, silently skipping any that already exist (re-ingestion after a partial
 * failure must never double-count). Each row: { trackedWallet, txHash, logIndex, direction,
 * counterpartyAddress, isSelfTransfer, isCex, assetType, tokenAddress, amountRaw, amountDecimal,
 * priceUsdAtTime, usdValue, gasFeeWei, blockNumber, timestamp }. */
export async function insertTransfers(rows) {
  if (!rows.length) return;

  const values = [];
  const placeholders = rows.map((r) => {
    const rowValues = rowToValues(r);
    if (rowValues.length !== COLUMNS.length) {
      throw new Error(`insertTransfers: row produced ${rowValues.length} values, expected ${COLUMNS.length}`);
    }
    const tuple = rowValues.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    return `(${tuple.join(",")})`;
  });

  await query(
    `INSERT INTO ingested_transfers (${COLUMNS.map((c) => (c === "timestamp" ? '"timestamp"' : c)).join(",")})
     VALUES ${placeholders.join(",")}
     ON CONFLICT (tracked_wallet, tx_hash, log_index) DO NOTHING`,
    values
  );
}

export async function getTransfersInRange(trackedWallet, fromTs, toTs) {
  const res = await query(
    `SELECT * FROM ingested_transfers
     WHERE tracked_wallet = $1 AND "timestamp" >= $2 AND "timestamp" < $3
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), fromTs, toTs]
  );
  return res?.rows || [];
}

export async function getAllTransfersBefore(trackedWallet, beforeTs) {
  const res = await query(
    `SELECT * FROM ingested_transfers WHERE tracked_wallet = $1 AND "timestamp" < $2
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), beforeTs]
  );
  return res?.rows || [];
}
