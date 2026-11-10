// Contract Check phase 4 storage (migrations/027): the change log the watchlist alerts read, and small
// cursors for the alert scheduler. Lean rows only (Supabase egress).
import { query } from "./pool.js";

/** Records one contract's owner / implementation / code-hash change. Returns its id (null without a DB). */
export async function insertContractChange(address, changes, label = null) {
  const res = await query(`INSERT INTO contract_changes (address, changes, label) VALUES ($1, $2, $3) RETURNING id`, [address.toLowerCase(), JSON.stringify(changes), label]);
  return res?.rows?.[0]?.id != null ? Number(res.rows[0].id) : null;
}

/** Changes newer than `afterId` for any of `addresses`, oldest first. */
export async function getChangesSince(afterId, addresses) {
  if (!addresses.length) return [];
  const res = await query(
    `SELECT id, address, changes, label, detected_at FROM contract_changes WHERE id > $1 AND address = ANY($2) ORDER BY id LIMIT 50`,
    [afterId, addresses.map((a) => a.toLowerCase())]
  );
  return (res?.rows || []).map((r) => ({ id: Number(r.id), address: r.address, changes: r.changes, label: r.label, detectedAt: r.detected_at }));
}

/** The newest change id (0 if none) — a new member's cursor starts here, so they aren't told about old ones. */
export async function latestChangeId() {
  const res = await query(`SELECT COALESCE(MAX(id), 0) AS id FROM contract_changes`);
  return Number(res?.rows?.[0]?.id || 0);
}

export async function getAlertState(key) {
  const res = await query(`SELECT value FROM contract_alert_state WHERE key = $1`, [key]);
  return res?.rows?.[0]?.value ?? null;
}

export async function setAlertState(key, value) {
  await query(
    `INSERT INTO contract_alert_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

/** Moves a cursor from `from` to `to` only if it still holds `from` (null = no row yet) — so when two
 * instances overlap during a deploy, exactly one of them wins the range and sends its alerts. */
export async function advanceAlertState(key, from, to) {
  const res =
    from === null
      ? await query(`INSERT INTO contract_alert_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, JSON.stringify(to)])
      : await query(`UPDATE contract_alert_state SET value = $3, updated_at = now() WHERE key = $1 AND value = $2::jsonb RETURNING key`, [key, JSON.stringify(from), JSON.stringify(to)]);
  return Boolean(res?.rows?.length);
}
