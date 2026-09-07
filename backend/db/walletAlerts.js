import { query } from "./pool.js";

// See migrations/009_alerts.sql's own header comment for the schema and why wallet_address is
// stored directly rather than as a tracked_wallets.id FK.
export const MAX_WALLET_ALERTS_PER_OWNER = 9; // ~3 per tracked wallet, across up to 3 tracked wallets

function normalizeRow(r) {
  return {
    id: r.id,
    walletAddress: r.wallet_address,
    alertType: r.alert_type,
    direction: r.direction,
    thresholdValue: r.threshold_value != null ? Number(r.threshold_value) : null,
    denomination: r.denomination,
    active: r.active,
    createdAt: r.created_at,
    lastTriggeredAt: r.last_triggered_at,
  };
}

/** Every wallet alert (active or not) belonging to `ownerWallet`, newest first — the dashboard's
 * own management list. Internal fields the scheduler owns (last_balance_state, last_seen_tx_hash)
 * are deliberately left off what's returned to the client — they're poll bookkeeping, not
 * something a user configures or needs to see. */
export async function getWalletAlerts(ownerWallet) {
  const res = await query(
    `SELECT id, wallet_address, alert_type, direction, threshold_value, denomination, active, created_at, last_triggered_at
     FROM wallet_alerts WHERE owner_wallet = $1 ORDER BY created_at DESC`,
    [ownerWallet.toLowerCase()]
  );
  return (res?.rows || []).map(normalizeRow);
}

/** Creates a balance-threshold or tx-activity alert for `walletAddress` (must already be one of
 * `ownerWallet`'s actively tracked wallets — checked by the caller, premiumAlertsRouter.js, against
 * getActiveTrackedWallets, since this module has no reason to depend on trackedWallets.js itself).
 *
 * `seedLastTxHash` (tx_activity only): the wallet's current newest transaction hash at creation
 * time, if any — stored as the starting cursor so the very first poll only reports transactions
 * that land AFTER creation, never the wallet's entire past history. Pass null for a wallet with no
 * transactions yet. */
export async function addWalletAlert(ownerWallet, { walletAddress, alertType, direction, thresholdValue, denomination, seedLastTxHash }) {
  const owner = ownerWallet.toLowerCase();
  const address = walletAddress.toLowerCase();

  const countRes = await query(`SELECT count(*) FROM wallet_alerts WHERE owner_wallet = $1 AND active`, [owner]);
  if (Number(countRes?.rows[0]?.count || 0) >= MAX_WALLET_ALERTS_PER_OWNER) {
    throw new Error(`You can have up to ${MAX_WALLET_ALERTS_PER_OWNER} active wallet alerts — remove one first`);
  }

  const res = await query(
    `INSERT INTO wallet_alerts
       (owner_wallet, wallet_address, alert_type, direction, threshold_value, denomination, last_seen_tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, wallet_address, alert_type, direction, threshold_value, denomination, active, created_at, last_triggered_at`,
    [owner, address, alertType, direction || null, thresholdValue ?? null, denomination || null, seedLastTxHash || null]
  );
  return normalizeRow(res.rows[0]);
}

/** Deletes one of `ownerWallet`'s own alerts — throws if it doesn't exist or belongs to someone
 * else, same "plain safe-to-return Error" convention as trackedWallets.js. */
export async function removeWalletAlert(ownerWallet, alertId) {
  const res = await query(
    `DELETE FROM wallet_alerts WHERE id = $1 AND owner_wallet = $2 RETURNING id`,
    [alertId, ownerWallet.toLowerCase()]
  );
  if (!res?.rows[0]) {
    throw new Error("Alert not found");
  }
}

/** Every active wallet_alerts row, grouped by wallet_address — walletAlertScheduler.js's own
 * per-poll access pattern: one Blockscout fetch per distinct wallet, checked against every alert
 * configured on it, rather than one fetch per alert. Includes owner_wallet (needed to look up the
 * Telegram chat + verify current Core tier access per alert) and the scheduler's own bookkeeping
 * columns, which getWalletAlerts() above deliberately omits from the client-facing shape. */
export async function getActiveWalletAlertsByWallet() {
  const res = await query(
    `SELECT id, owner_wallet, wallet_address, alert_type, direction, threshold_value, denomination,
            last_balance_state, last_seen_tx_hash
     FROM wallet_alerts WHERE active ORDER BY wallet_address`
  );
  const byWallet = new Map();
  for (const r of res?.rows || []) {
    if (!byWallet.has(r.wallet_address)) byWallet.set(r.wallet_address, []);
    byWallet.get(r.wallet_address).push({
      id: r.id,
      ownerWallet: r.owner_wallet,
      walletAddress: r.wallet_address,
      alertType: r.alert_type,
      direction: r.direction,
      thresholdValue: r.threshold_value != null ? Number(r.threshold_value) : null,
      denomination: r.denomination,
      lastBalanceState: r.last_balance_state,
      lastSeenTxHash: r.last_seen_tx_hash,
    });
  }
  return byWallet;
}

/** Records a balance_threshold alert's crossing state after a poll — called every poll regardless
 * of whether it fired, since this is what lets the NEXT poll detect a transition rather than
 * re-evaluating from scratch. */
export async function setWalletAlertBalanceState(alertId, state, { triggered = false } = {}) {
  await query(
    `UPDATE wallet_alerts SET last_balance_state = $2, last_triggered_at = CASE WHEN $3 THEN now() ELSE last_triggered_at END WHERE id = $1`,
    [alertId, state, triggered]
  );
}

/** Advances a tx_activity alert's "newest seen" cursor — called every poll (whether or not any new
 * transaction actually crossed the min-amount filter) so a wallet with frequent below-threshold
 * activity doesn't keep re-scanning the same already-seen transactions forever. */
export async function setWalletAlertTxCursor(alertId, txHash, { triggered = false } = {}) {
  await query(
    `UPDATE wallet_alerts SET last_seen_tx_hash = $2, last_triggered_at = CASE WHEN $3 THEN now() ELSE last_triggered_at END WHERE id = $1`,
    [alertId, txHash, triggered]
  );
}

/** Deactivates alerts whose wallet has since been untracked — walletAlertScheduler.js calls this
 * once per poll per wallet found no longer in the owner's active tracked-wallet list, rather than
 * leaving a permanently-skipped-but-still-"active" row around indefinitely. */
export async function deactivateWalletAlerts(alertIds) {
  if (alertIds.length === 0) return;
  await query(`UPDATE wallet_alerts SET active = false WHERE id = ANY($1::uuid[])`, [alertIds]);
}
