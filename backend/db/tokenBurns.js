import { query } from "./pool.js";

// See migrations/017_token_burns.sql's own header comment for the full picture — resumable
// per-token burn-scan state (token_burn_cursor) plus the actual found burn events
// (token_burn_events), read by backend/services/tokenBurnService.js.

export async function getTokenBurnCursor(tokenAddress) {
  const res = await query(
    `SELECT deploy_block, low_scanned_block, high_scanned_block, updated_at
     FROM token_burn_cursor WHERE token_address = $1`,
    [tokenAddress.toLowerCase()]
  );
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    deployBlock: row.deploy_block != null ? Number(row.deploy_block) : null,
    lowScannedBlock: row.low_scanned_block != null ? Number(row.low_scanned_block) : null,
    highScannedBlock: row.high_scanned_block != null ? Number(row.high_scanned_block) : null,
    updatedAt: row.updated_at,
  };
}

export async function upsertTokenBurnCursor(tokenAddress, { deployBlock, lowScannedBlock, highScannedBlock }) {
  await query(
    `INSERT INTO token_burn_cursor (token_address, deploy_block, low_scanned_block, high_scanned_block, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (token_address) DO UPDATE SET
       deploy_block = COALESCE(EXCLUDED.deploy_block, token_burn_cursor.deploy_block),
       low_scanned_block = EXCLUDED.low_scanned_block,
       high_scanned_block = EXCLUDED.high_scanned_block,
       updated_at = now()`,
    [tokenAddress.toLowerCase(), deployBlock ?? null, lowScannedBlock, highScannedBlock]
  );
}

/** Bulk-inserts newly-found burn events, deduped by (token_address, tx_hash, log_index) — safe to
 * call with events this table already has (a resumed/overlapping scan range), those rows are
 * simply skipped. No-op for an empty array. */
export async function insertTokenBurnEvents(tokenAddress, events) {
  if (!events || events.length === 0) return;
  await Promise.all(
    events.map((e) =>
      query(
        `INSERT INTO token_burn_events (token_address, tx_hash, log_index, from_address, amount, block_number, "timestamp")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (token_address, tx_hash, log_index) DO NOTHING`,
        [tokenAddress.toLowerCase(), e.txHash, e.logIndex, e.fromAddress.toLowerCase(), e.amount, e.blockNumber, new Date(e.timestampMs)]
      )
    )
  );
}

/** Every known burn event for `tokenAddress`, oldest first — the service layer builds the
 * cumulative daily series and "recent burns" list from this. Burns are rare enough per token
 * (unlike, say, every transfer) that returning the full history in one call is fine — no pagination
 * needed here, matching nftSalesCache.js's own "just return the whole known list" convention for a
 * similarly low-volume, chart-feeding dataset. */
/** Every distinct token that has at least one stored burn event — for
 * scripts/fixTokenBurnSenders.js, which corrects `from_address` on rows scanned before
 * tokenBurnService.js's scanRange started preferring the transaction's own sender over the
 * Transfer log's `from` (see that fix's own header comment). */
export async function getDistinctTokensWithBurnEvents() {
  const res = await query(`SELECT DISTINCT token_address FROM token_burn_events`);
  return (res?.rows || []).map((r) => r.token_address);
}

/** Every distinct tx_hash already stored for `tokenAddress` — one on-chain sender lookup per
 * transaction is enough to fix every row that shares it (a tx can contain more than one burn log,
 * e.g. multi-hop swaps), rather than one lookup per row. */
export async function getDistinctBurnTxHashes(tokenAddress) {
  const res = await query(`SELECT DISTINCT tx_hash FROM token_burn_events WHERE token_address = $1`, [tokenAddress.toLowerCase()]);
  return (res?.rows || []).map((r) => r.tx_hash);
}

/** Overwrites `from_address` for every row of `tokenAddress`/`txHash` (there's exactly one real
 * sender per transaction, however many burn logs it contains) — a no-op UPDATE (same value) if
 * nothing was actually wrong. Returns how many rows changed. */
export async function updateBurnEventSender(tokenAddress, txHash, fromAddress) {
  const res = await query(
    `UPDATE token_burn_events SET from_address = $1 WHERE token_address = $2 AND tx_hash = $3 AND from_address IS DISTINCT FROM $1`,
    [fromAddress.toLowerCase(), tokenAddress.toLowerCase(), txHash]
  );
  return res?.rowCount || 0;
}

export async function getTokenBurnEvents(tokenAddress) {
  const res = await query(
    `SELECT tx_hash, log_index, from_address, amount, block_number, "timestamp"
     FROM token_burn_events WHERE token_address = $1 ORDER BY "timestamp" ASC`,
    [tokenAddress.toLowerCase()]
  );
  return (res?.rows || []).map((r) => ({
    txHash: r.tx_hash,
    logIndex: r.log_index,
    fromAddress: r.from_address,
    amount: r.amount,
    blockNumber: Number(r.block_number),
    timestampMs: new Date(r.timestamp).getTime(),
  }));
}
