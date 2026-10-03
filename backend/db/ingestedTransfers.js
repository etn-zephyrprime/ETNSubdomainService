import { query, chunkArray } from "./pool.js";

// Max rows per INSERT statement — see pool.js's own chunkArray comment for why this exists at
// all (a real production crash, not a preemptive guess) and why 500 is comfortably safe here:
// 500 * COLUMNS.length (17) = 8,500 bound parameters, well under the ~32,768 threshold that
// actually broke.
const BATCH_SIZE = 500;

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
  "token_id",
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
    r.tokenId ?? null,
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
 * counterpartyAddress, isSelfTransfer, isCex, assetType, tokenAddress, tokenId, amountRaw, amountDecimal,
 * priceUsdAtTime, usdValue, gasFeeWei, blockNumber, timestamp }. */
export async function insertTransfers(rows) {
  if (!rows.length) return;

  // Chunked — see pool.js's own chunkArray comment for why a single INSERT built from the WHOLE
  // row list can silently corrupt at large batch sizes (confirmed live, not theoretical).
  for (const batch of chunkArray(rows, BATCH_SIZE)) {
    const values = [];
    const placeholders = batch.map((r) => {
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

  // Invalidate getAllTransfersBefore's own memo (below) for every wallet this batch touched — a
  // stale memo entry must never survive real new data landing for that wallet, or the ledger/NFT/
  // token-history caches' own "ingestion advanced -> rebuild" invalidation would be silently
  // undermined by this memo quietly still serving the PRE-ingestion read underneath them.
  const affectedWallets = new Set(rows.map((r) => r.trackedWallet.toLowerCase()));
  for (const wallet of affectedWallets) transfersMemo.delete(wallet);
}

/** Every transfer of ONE specific fungible token for `trackedWallet`, oldest first — narrow
 * columns only (not `SELECT *`, unlike this file's whole-history reads above), since balance
 * replay only needs direction/amount/timestamp. Powers tokenBalanceHistoryService.js's per-token
 * Balance History chart. `is_self_transfer` is irrelevant here (unlike for PnL) — tokens moving
 * between a member's own wallets still genuinely leave/enter THIS wallet's own on-chain balance,
 * which is exactly what a balance-over-time chart is supposed to reflect. */
export async function getTokenTransfersForWallet(trackedWallet, tokenAddress) {
  const res = await query(
    `SELECT direction, amount_decimal, "timestamp"
     FROM ingested_transfers
     WHERE tracked_wallet = $1 AND asset_type = 'erc20' AND token_address = $2
     ORDER BY "timestamp" ASC`,
    [trackedWallet.toLowerCase(), tokenAddress.toLowerCase()]
  );
  return res?.rows || [];
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

// Short-lived, per-wallet memo of getAllTransfersBefore's own result. Confirmed live via
// pg_stat_statements: 3,106 calls / 9.93 MILLION rows from this one query alone — the single
// largest source of remaining Supabase egress, bigger than everything else combined. Root cause:
// several independent, otherwise-correct caches each need "this wallet's full event history" —
// pnlSnapshotService.js's getLedgerState, nftPnlService.js's own NFT snapshot cache, and
// tokenPnlService.js's own per-token history cache — and each rebuilds on its OWN schedule when it
// sees ingestion has advanced, but NONE of them share the underlying database read with each other.
// One new transfer landing for an active wallet can trigger this exact full-history SELECT *
// multiple times within moments, once per independent cache that happens to miss around the same
// time.
//
// Deliberately NOT keyed to the exact `beforeTs` requested — every current caller passes a freshly
// captured `new Date()` (i.e. "live, as of right now"), so two calls a few seconds apart would
// otherwise miss each other by milliseconds and never collapse. Instead: a cached result is reused
// only if it was fetched within MEMO_TTL_MS AND the newly requested `beforeTs` falls within that
// same short window of the cached fetch's own `beforeTs`. Safe for every live caller — this app
// already accepts exactly this much staleness elsewhere for exactly this reason (see
// SNAPSHOT_CACHE_TTL_MS/SCAN_COOLDOWN_MS's own identical "collapse near-simultaneous calls" logic)
// — and a correctness no-op for pnlStatementGenerator.js's period-scoped calls: a frozen statement's
// `periodEnd` is some date in the past, essentially never within MEMO_TTL_MS of "right now" the way
// a live call's `beforeTs` always is, so that caller keeps hitting the database with an exact query
// every time, unaffected — exactly what a tax-document-grade figure needs (see fifoLotEngine.js's
// own header comment on precision).
//
// insertTransfers above clears a wallet's entry the moment new rows land for it, so this can never
// serve pre-ingestion data to a caller that specifically woke up BECAUSE ingestion advanced.
const MEMO_TTL_MS = 20000;
const MEMO_MAX_ENTRIES = 12; // small — each entry holds a wallet's FULL raw transfer history, not a compact summary
const transfersMemo = new Map(); // trackedWallet (lowercase) -> { rows, beforeTsMs, fetchedAtMs }

function rememberTransfers(trackedWallet, beforeTsMs, rows) {
  transfersMemo.delete(trackedWallet); // re-insert so Map order is recency order
  transfersMemo.set(trackedWallet, { rows, beforeTsMs, fetchedAtMs: Date.now() });
  while (transfersMemo.size > MEMO_MAX_ENTRIES) transfersMemo.delete(transfersMemo.keys().next().value);
}

export async function getAllTransfersBefore(trackedWallet, beforeTs) {
  const wallet = trackedWallet.toLowerCase();
  const beforeTsMs = new Date(beforeTs).getTime();

  const hit = transfersMemo.get(wallet);
  if (hit && Date.now() - hit.fetchedAtMs < MEMO_TTL_MS && Math.abs(beforeTsMs - hit.beforeTsMs) < MEMO_TTL_MS) {
    return hit.rows;
  }

  const res = await query(
    `SELECT * FROM ingested_transfers WHERE tracked_wallet = $1 AND "timestamp" < $2
     ORDER BY "timestamp" ASC, log_index ASC`,
    [wallet, beforeTs]
  );
  const rows = res?.rows || [];
  rememberTransfers(wallet, beforeTsMs, rows);
  return rows;
}

/** Rows left with no price — either a deliberately-deferred non-priority asset (see
 * pnlIngestion.js's priorityAssets) or a genuine historical lookup failure at ingestion time.
 * Excludes NFT rows (erc721/erc1155), which are NEVER priced this way (see pnlEventBuilder.js's
 * buildNftEvents) — those having a null price is normal, not something to backfill.
 * backfillDeferredPrices' own read list. */
export async function getUnpricedTransfers(trackedWallet) {
  const res = await query(
    `SELECT id, asset_type, token_address, amount_decimal, "timestamp"
     FROM ingested_transfers
     WHERE tracked_wallet = $1 AND asset_type IN ('native', 'erc20') AND price_usd_at_time IS NULL`,
    [trackedWallet.toLowerCase()]
  );
  return res?.rows || [];
}

/** Fills in a previously-null price for one row, in place — never re-walks Blockscout, this only
 * updates the two price columns on a row that already exists. */
export async function setTransferPrice(id, priceUsd, usdValue) {
  await query(`UPDATE ingested_transfers SET price_usd_at_time = $2, usd_value = $3 WHERE id = $1`, [id, priceUsd, usdValue]);
}
