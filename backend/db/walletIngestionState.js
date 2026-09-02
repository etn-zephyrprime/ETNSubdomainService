import { query } from "./pool.js";

// Per-wallet ingestion cursor — relational analogue of the dual-cursor shape in
// backend/state/nftSalesState.js, now keyed per tracked wallet instead of one global object.

export async function getIngestionState(trackedWallet) {
  const res = await query("SELECT * FROM wallet_ingestion_state WHERE tracked_wallet = $1", [
    trackedWallet.toLowerCase(),
  ]);
  return res?.rows[0] || null;
}

// lastIngestedDefiBlock is optional and defaults to leaving the stored value untouched (COALESCE
// against the existing row) rather than NULLing it out — a caller that only advanced the other four
// walks (e.g. a future code path that doesn't scan DeFi activity at all) must never regress the
// DeFi cursor back to "cold start". See migration 006's own comment for why this is a separate
// cursor from lastIngestedBlock in the first place.
export async function upsertIngestionState(trackedWallet, { lastIngestedBlock, coldStartCompletedAt, lastIngestedDefiBlock }) {
  await query(
    `INSERT INTO wallet_ingestion_state (tracked_wallet, last_ingested_block, cold_start_completed_at, last_ingested_defi_block, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tracked_wallet) DO UPDATE
       SET last_ingested_block = EXCLUDED.last_ingested_block,
           cold_start_completed_at = COALESCE(wallet_ingestion_state.cold_start_completed_at, EXCLUDED.cold_start_completed_at),
           last_ingested_defi_block = COALESCE(EXCLUDED.last_ingested_defi_block, wallet_ingestion_state.last_ingested_defi_block),
           updated_at = now()`,
    [trackedWallet.toLowerCase(), lastIngestedBlock, coldStartCompletedAt || null, lastIngestedDefiBlock ?? null]
  );
}
