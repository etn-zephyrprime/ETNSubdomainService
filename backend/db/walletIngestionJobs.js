import { query } from "./pool.js";

// Read/write access for wallet_ingestion_jobs (see migration 015's own comment for what this table
// is and how it differs from wallet_ingestion_state). One exported function per state transition,
// same guard-clause idiom as statementRequests.js: a transition's UPDATE only applies `WHERE
// status = '<expected prior state>'`, returning cleanly (not throwing) rather than clobbering a
// row a concurrent caller has already moved on from.

/** Reads the current job row for `trackedWallet`, or null if none exists yet. */
export async function getIngestJob(trackedWallet) {
  const res = await query("SELECT * FROM wallet_ingestion_jobs WHERE tracked_wallet = $1", [
    trackedWallet.toLowerCase(),
  ]);
  return res?.rows[0] || null;
}

/** Starts (or restarts) a job as RUNNING. `progressTotal` is the chain's own latest block height at
 * job start (see migration 015's own comment — this literally IS "Y" in "reading block X of Y"),
 * `progressCurrent` its starting position (the older of the wallet's two resume cursors). Called
 * TWICE per real ingestion run by design: once as an immediate placeholder (progressTotal 0,
 * progressCurrent 0, stage "Starting…") by checkAndStartIngestIfNeeded below — BEFORE the
 * background ingest promise is even kicked off — so a poller's very first request always finds a
 * real row rather than racing doIngestWalletHistory's own first write; then again by
 * doIngestWalletHistory itself once it's computed the real numbers, overwriting the placeholder.
 * Callers must not call this a SECOND time once a run is genuinely in progress
 * (checkAndStartIngestIfNeeded guards this via its own `existingJob.status !== 'RUNNING'` check) —
 * doing so would reset real progress back to its starting point. */
export async function startJob(trackedWallet, { progressTotal = 0, progressCurrent = 0, stage = "Starting…" } = {}) {
  await query(
    `INSERT INTO wallet_ingestion_jobs (tracked_wallet, status, stage, progress_current, progress_total, error_message, started_at, updated_at)
     VALUES ($1, 'RUNNING', $2, $3, $4, NULL, now(), now())
     ON CONFLICT (tracked_wallet) DO UPDATE
       SET status = 'RUNNING', stage = EXCLUDED.stage, progress_current = EXCLUDED.progress_current, progress_total = EXCLUDED.progress_total,
           error_message = NULL, started_at = now(), updated_at = now()`,
    [trackedWallet.toLowerCase(), stage, progressCurrent, progressTotal]
  );
}

/** Updates the running total shown to a poller. Guarded to RUNNING rows only — a stray late
 * progress callback firing after the job has already been marked COMPLETE/FAILED (e.g. a
 * throttled callback's timer firing just after the job's own last real write) must not silently
 * resurrect it as if still in progress. */
export async function updateJobProgress(trackedWallet, { current, stage }) {
  await query(
    `UPDATE wallet_ingestion_jobs SET progress_current = $2, stage = $3, updated_at = now()
     WHERE tracked_wallet = $1 AND status = 'RUNNING'`,
    [trackedWallet.toLowerCase(), current, stage]
  );
}

export async function completeJob(trackedWallet) {
  await query(
    `UPDATE wallet_ingestion_jobs SET status = 'COMPLETE', updated_at = now() WHERE tracked_wallet = $1 AND status = 'RUNNING'`,
    [trackedWallet.toLowerCase()]
  );
}

export async function failJob(trackedWallet, errorMessage) {
  await query(
    `UPDATE wallet_ingestion_jobs SET status = 'FAILED', error_message = $2, updated_at = now() WHERE tracked_wallet = $1 AND status = 'RUNNING'`,
    [trackedWallet.toLowerCase(), errorMessage]
  );
}
