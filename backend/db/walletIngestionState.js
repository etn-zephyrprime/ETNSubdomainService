import { query } from "./pool.js";

// Per-wallet ingestion cursor — relational analogue of the dual-cursor shape in
// backend/state/nftSalesState.js, now keyed per tracked wallet instead of one global object.

export async function getIngestionState(trackedWallet) {
  const res = await query("SELECT * FROM wallet_ingestion_state WHERE tracked_wallet = $1", [
    trackedWallet.toLowerCase(),
  ]);
  return res?.rows[0] || null;
}

export async function upsertIngestionState(trackedWallet, { lastIngestedBlock, coldStartCompletedAt }) {
  await query(
    `INSERT INTO wallet_ingestion_state (tracked_wallet, last_ingested_block, cold_start_completed_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tracked_wallet) DO UPDATE
       SET last_ingested_block = EXCLUDED.last_ingested_block,
           cold_start_completed_at = COALESCE(wallet_ingestion_state.cold_start_completed_at, EXCLUDED.cold_start_completed_at),
           updated_at = now()`,
    [trackedWallet.toLowerCase(), lastIngestedBlock, coldStartCompletedAt || null]
  );
}
