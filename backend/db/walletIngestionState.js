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
// `updated_at` is more than a timestamp — it's the freshness/correctness signal every live-value
// cache in this backend keys off (pnlSnapshotService.js's snapshotCache, defiPositionValuation.js's
// positionsCache, and wallet_position_cache's own 'defi' fingerprint): "unchanged since I cached
// this" is supposed to mean "nothing new could possibly have altered the computation." Confirmed
// live this was NOT actually true: every caller of this function (doIngestWalletHistory,
// ensureDefiActivityIngested, checkAndStartDefiIngestIfNeeded's own scan) initializes its own
// "highest block reached" to the PREVIOUS cursor value, so it's >= 0 (truthy) and calls this
// function on literally every ingestion attempt, including the overwhelmingly common "nothing new
// since last time" case — bumping updated_at regardless of whether either cursor actually moved.
// With "always sync on reconnect" meaning ingestion is attempted on every single page load/poll,
// this made updated_at change almost continuously for an actively-viewed wallet, defeating every
// cache keyed on it and — worse — making a cache's own "still correct, not just cached" guarantee
// silently false. Only actually bump it when a cursor genuinely advanced (or cold start just
// completed, also a real state transition those same callers care about) — a same-value write is
// now a true no-op as far as every downstream cache is concerned, which is what all of their own
// header comments already claimed was happening.
export async function upsertIngestionState(trackedWallet, { lastIngestedBlock, coldStartCompletedAt, lastIngestedDefiBlock }) {
  await query(
    `INSERT INTO wallet_ingestion_state (tracked_wallet, last_ingested_block, cold_start_completed_at, last_ingested_defi_block, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tracked_wallet) DO UPDATE
       SET last_ingested_block = EXCLUDED.last_ingested_block,
           cold_start_completed_at = COALESCE(wallet_ingestion_state.cold_start_completed_at, EXCLUDED.cold_start_completed_at),
           last_ingested_defi_block = COALESCE(EXCLUDED.last_ingested_defi_block, wallet_ingestion_state.last_ingested_defi_block),
           updated_at = CASE
             WHEN wallet_ingestion_state.last_ingested_block IS DISTINCT FROM EXCLUDED.last_ingested_block THEN now()
             WHEN EXCLUDED.last_ingested_defi_block IS NOT NULL
                  AND wallet_ingestion_state.last_ingested_defi_block IS DISTINCT FROM EXCLUDED.last_ingested_defi_block THEN now()
             WHEN wallet_ingestion_state.cold_start_completed_at IS NULL AND EXCLUDED.cold_start_completed_at IS NOT NULL THEN now()
             ELSE wallet_ingestion_state.updated_at
           END`,
    [trackedWallet.toLowerCase(), lastIngestedBlock, coldStartCompletedAt || null, lastIngestedDefiBlock ?? null]
  );
}
