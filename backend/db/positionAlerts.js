import { query } from "./pool.js";

export const POSITION_ALERT_TYPES = ["il_threshold", "v3_out_of_range", "farm_multiplier"];
// How far IL must recover past the threshold before an il_threshold alert can fire again (the
// hysteresis the user chose: 2 points — a 5% alert re-arms at -3%).
export const IL_REARM_POINTS = 2;
// The IL threshold must leave room for the re-arm point to be a real (negative) IL figure.
export const MIN_IL_THRESHOLD_PCT = IL_REARM_POINTS + 0.5;
export const MAX_IL_THRESHOLD_PCT = 90;

function normalizeRow(r) {
  return {
    id: r.id,
    alertType: r.alert_type,
    thresholdPct: r.threshold_pct == null ? null : Number(r.threshold_pct),
    active: r.active,
    createdAt: r.created_at,
    lastTriggeredAt: r.last_triggered_at,
  };
}

/** Every position alert belonging to `ownerWallet` (one per type at most). */
export async function getPositionAlerts(ownerWallet) {
  const res = await query(
    `SELECT id, alert_type, threshold_pct, active, created_at, last_triggered_at
     FROM position_alerts WHERE owner_wallet = $1 ORDER BY created_at`,
    [ownerWallet.toLowerCase()]
  );
  return (res?.rows || []).map(normalizeRow);
}

/** Creates or updates `ownerWallet`'s alert of `alertType` (one per type). Changing an IL
 * threshold clears the per-position state, so every position is judged afresh against the new line. */
export async function upsertPositionAlert(ownerWallet, { alertType, thresholdPct = null }) {
  const res = await query(
    `INSERT INTO position_alerts (owner_wallet, alert_type, threshold_pct)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_wallet, alert_type) DO UPDATE
       SET threshold_pct = EXCLUDED.threshold_pct,
           active = true,
           position_state = CASE WHEN position_alerts.threshold_pct IS DISTINCT FROM EXCLUDED.threshold_pct
                                 THEN '{}'::jsonb ELSE position_alerts.position_state END
     RETURNING id, alert_type, threshold_pct, active, created_at, last_triggered_at`,
    [ownerWallet.toLowerCase(), alertType, thresholdPct]
  );
  return normalizeRow(res.rows[0]);
}

/** Deletes one of `ownerWallet`'s own alerts — throws if it doesn't exist or belongs to someone else. */
export async function removePositionAlert(ownerWallet, alertId) {
  const res = await query(`DELETE FROM position_alerts WHERE id = $1 AND owner_wallet = $2 RETURNING id`, [alertId, ownerWallet.toLowerCase()]);
  if (!res?.rows[0]) throw new Error("Alert not found");
}

/** Every active alert, grouped by owner: Map(owner -> [{ id, alertType, thresholdPct, positionState }]). */
export async function getAllActivePositionAlerts() {
  const res = await query(
    `SELECT id, owner_wallet, alert_type, threshold_pct, position_state FROM position_alerts WHERE active ORDER BY owner_wallet`
  );
  const byOwner = new Map();
  for (const r of res?.rows || []) {
    if (!byOwner.has(r.owner_wallet)) byOwner.set(r.owner_wallet, []);
    byOwner.get(r.owner_wallet).push({
      id: r.id,
      alertType: r.alert_type,
      thresholdPct: r.threshold_pct == null ? null : Number(r.threshold_pct),
      positionState: r.position_state || {},
    });
  }
  return byOwner;
}

/** Saves the per-position state after a check; `triggered` also stamps last_triggered_at. */
export async function savePositionAlertState(alertId, positionState, triggered) {
  await query(
    `UPDATE position_alerts SET position_state = $2::jsonb${triggered ? ", last_triggered_at = now()" : ""} WHERE id = $1`,
    [alertId, JSON.stringify(positionState)]
  );
}
