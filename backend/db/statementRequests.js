import { query } from "./pool.js";

// The statement request state machine's own table: PAID -> PENDING_GENERATION -> GENERATED ->
// FINALIZED (or REFUNDED from any of the first three). A row only ever gets created from a
// confirmed on-chain PnlPeriodPurchased event (see premiumSubscriptionWatcher.js) — never from a
// client-submitted claim. periodType/year identify one of the four fixed reporting periods (see
// backend/services/periodTypes.js); logIndex is the log's own on-chain identity, used for dedup.

export async function createFromPurchase({ txHash, logIndex, periodType, year, trackedWallet, payerWallet, amountPaidWei }) {
  const res = await query(
    `INSERT INTO statement_requests (tx_hash, log_index, period_type, year, tracked_wallet, payer_wallet, amount_paid_wei)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING *`,
    [txHash, logIndex, periodType, year, trackedWallet.toLowerCase(), payerWallet.toLowerCase(), amountPaidWei.toString()]
  );
  return res?.rows[0] || null; // null if this exact (tx_hash, log_index) was already recorded
}

/** Cumulative count of statement requests over time, one point per day that had at least one
 * purchase, oldest first — keyed on created_at (row creation, from the confirmed on-chain
 * purchase event, see createFromPurchase), not generated_at: this counts every request as soon
 * as it's paid for, regardless of whether generation has completed, stalled, or errored out yet.
 * Powers the PnL Statements tab's cumulative chart. Computed with a window function server-side
 * rather than shipping every row's raw timestamp to the client for it to count there itself. */
export async function getCumulativeRequestedSeries() {
  const res = await query(
    `SELECT day, SUM(day_count) OVER (ORDER BY day) AS cumulative
     FROM (
       SELECT created_at::date AS day, COUNT(*) AS day_count
       FROM statement_requests
       GROUP BY created_at::date
     ) per_day
     ORDER BY day ASC`
  );
  return (res?.rows || []).map((r) => ({ label: r.day, value: Number(r.cumulative) }));
}

export async function getById(id) {
  const res = await query("SELECT * FROM statement_requests WHERE id = $1", [id]);
  return res?.rows[0] || null;
}

export async function getByTxHash(txHash) {
  const res = await query(
    "SELECT * FROM statement_requests WHERE tx_hash = $1 ORDER BY log_index ASC",
    [txHash]
  );
  return res?.rows || [];
}

/** Every request a wallet has ever paid for, oldest first — powers the frontend's "N of M ready"
 * progress tracker (see PnlStatementProgress.jsx). payer_wallet, not tracked_wallet: someone can
 * buy a statement for a wallet other than their own connected one, and it's the payer's own
 * purchase history this is meant to show them, mirroring how purchasePnlPeriods' on-chain
 * PnlPeriodsPurchased event keys off msg.sender, not the tracked wallet argument. */
export async function getByPayerWallet(payerWallet) {
  const res = await query(
    "SELECT * FROM statement_requests WHERE payer_wallet = $1 ORDER BY created_at ASC",
    [payerWallet.toLowerCase()]
  );
  return res?.rows || [];
}

/** PENDING_GENERATION with the user-supplied self-owned-addresses list — only legal from PAID.
 * Unlike the earlier design, no period metadata is submitted here: period_type/year are already
 * known from the purchase event itself (see createFromPurchase). */
export async function markPendingGeneration(id, { selfOwnedAddresses }) {
  const res = await query(
    `UPDATE statement_requests
     SET status = 'PENDING_GENERATION', self_owned_addresses = $2::jsonb, updated_at = now()
     WHERE id = $1 AND status = 'PAID'
     RETURNING *`,
    [id, JSON.stringify(selfOwnedAddresses || [])]
  );
  return res?.rows[0] || null;
}

/** GENERATED with the frozen artifact's R2 keys — only legal from PENDING_GENERATION. */
export async function markGenerated(id, { artifactPdfKey, artifactJsonKey }) {
  const res = await query(
    `UPDATE statement_requests
     SET status = 'GENERATED', generated_at = now(),
         artifact_pdf_key = $2, artifact_json_key = $3, updated_at = now()
     WHERE id = $1 AND status = 'PENDING_GENERATION'
     RETURNING *`,
    [id, artifactPdfKey, artifactJsonKey]
  );
  return res?.rows[0] || null;
}

/** Marks first_viewed_at (if not already set) and, only if still GENERATED, transitions to
 * FINALIZED in the same statement — this is the single row-level atomicity the "split fires
 * exactly once" guarantee rests on, since a concurrent duplicate /view call will find status is
 * no longer GENERATED on its own UPDATE and simply get back the already-finalized row. */
export async function markViewedAndFinalize(id) {
  const res = await query(
    `UPDATE statement_requests
     SET first_viewed_at = COALESCE(first_viewed_at, now()),
         status = CASE WHEN status = 'GENERATED' THEN 'FINALIZED' ELSE status END,
         finalized_at = CASE WHEN status = 'GENERATED' THEN now() ELSE finalized_at END,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res?.rows[0] || null;
}

/** Rows the 14-day auto-finalize job should transition — naturally idempotent via the status
 * column itself (see pnlAutoFinalizeScheduler.js), no separate "already processed" tracking. */
export async function findGeneratedPastAutoFinalizeThreshold(thresholdMs) {
  const res = await query(
    `SELECT * FROM statement_requests
     WHERE status = 'GENERATED' AND first_viewed_at IS NULL
       AND generated_at < now() - ($1 || ' milliseconds')::interval`,
    [thresholdMs]
  );
  return res?.rows || [];
}

export async function finalizeByAutoTimeout(id) {
  const res = await query(
    `UPDATE statement_requests
     SET status = 'FINALIZED', finalized_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'GENERATED'
     RETURNING *`,
    [id]
  );
  return res?.rows[0] || null;
}

/** FINALIZED rows with real money on the table and no split executed yet — the split scheduler's
 * work queue. A free member purchase (amount_paid_wei = 0) never appears here; nothing to split. */
export async function findFinalizedNeedingSplit() {
  const res = await query(
    `SELECT sr.* FROM statement_requests sr
     LEFT JOIN buy_and_burn_log bb ON bb.statement_request_id = sr.id
     WHERE sr.status = 'FINALIZED' AND sr.amount_paid_wei > 0 AND bb.id IS NULL`
  );
  return res?.rows || [];
}

/** Only legal before either finalize trigger (PAID/PENDING_GENERATION/GENERATED-and-unviewed). */
export async function markRefunded(id, refundTxHash) {
  const res = await query(
    `UPDATE statement_requests
     SET status = 'REFUNDED', refunded_at = now(), refund_tx_hash = $2, updated_at = now()
     WHERE id = $1 AND status IN ('PAID', 'PENDING_GENERATION', 'GENERATED') AND first_viewed_at IS NULL
     RETURNING *`,
    [id, refundTxHash]
  );
  return res?.rows[0] || null;
}
