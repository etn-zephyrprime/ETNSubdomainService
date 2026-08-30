// backend/utils/pnlAutoFinalizeScheduler.js
//
// The 14-day auto-finalize leg of the statement request state machine (see PremiumSubscription.sol
// and pnlStatementRouter.js's /view endpoint for the other leg — user-triggered finalize-on-view).
// A request left GENERATED with no first_viewed_at for PNL_AUTO_FINALIZE_MS transitions to
// FINALIZED automatically, same as if the user had viewed it — this is only a refund-eligibility
// change, not an access change (the artifact was already permanently viewable from GENERATED on).
//
// Same isRunning + setInterval shape as expiryAlertScheduler.js. Unlike that file, no separate
// "already alerted" dedupe map is needed — the status column itself is the idempotency guard: a
// row this query returns is always GENERATED-and-stale, and finalizeByAutoTimeout()'s own
// `WHERE status = 'GENERATED'` means a row already flipped (by this job or a concurrent /view
// call) simply updates zero rows the second time, harmlessly.
import { getPool } from "../db/pool.js";
import { findGeneratedPastAutoFinalizeThreshold, finalizeByAutoTimeout } from "../db/statementRequests.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
// Overridable specifically so the testnet lifecycle test (see the PnL statement build plan) can
// exercise this path on an accelerated clock instead of waiting 14 real days.
const AUTO_FINALIZE_THRESHOLD_MS = process.env.PNL_AUTO_FINALIZE_MS
  ? parseInt(process.env.PNL_AUTO_FINALIZE_MS, 10)
  : FOURTEEN_DAYS_MS;
const CHECK_INTERVAL_MS = process.env.PNL_AUTO_FINALIZE_CHECK_INTERVAL_MS
  ? parseInt(process.env.PNL_AUTO_FINALIZE_CHECK_INTERVAL_MS, 10)
  : 60 * 60 * 1000; // hourly — a request's exact finalize moment doesn't need sub-hour precision

let isRunning = false;

async function checkAndFinalize() {
  if (isRunning) return;
  isRunning = true;
  try {
    const stale = await findGeneratedPastAutoFinalizeThreshold(AUTO_FINALIZE_THRESHOLD_MS);
    for (const request of stale) {
      try {
        const finalized = await finalizeByAutoTimeout(request.id);
        if (finalized) {
          console.log(`⏰ Statement request ${request.id} auto-finalized after ${AUTO_FINALIZE_THRESHOLD_MS / 1000}s unviewed (wallet ${request.tracked_wallet})`);
        }
      } catch (err) {
        console.error(`⚠️  Failed to auto-finalize statement request ${request.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("⚠️  PnL auto-finalize check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background checker. No-op if DATABASE_URL isn't configured. */
export function startPnlAutoFinalizeScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — PnL auto-finalize scheduler disabled");
    return;
  }

  console.log(`⏰ PnL auto-finalize scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s, threshold ${AUTO_FINALIZE_THRESHOLD_MS / 1000}s)`);
  checkAndFinalize();
  setInterval(checkAndFinalize, CHECK_INTERVAL_MS);
}
