import { query } from "./pool.js";

export const MAX_PORTFOLIO_ALERTS_PER_OWNER = 5; // one owner, no per-token fan-out — a handful is plenty

function normalizeRow(r) {
  return {
    id: r.id,
    direction: r.direction,
    thresholdPct: Number(r.threshold_pct),
    baselineUsd: Number(r.baseline_usd),
    active: r.active,
    createdAt: r.created_at,
    lastTriggeredAt: r.last_triggered_at,
  };
}

/** Every portfolio alert (active or not) belonging to `ownerWallet`, newest first. */
export async function getPortfolioAlerts(ownerWallet) {
  const res = await query(
    `SELECT id, direction, threshold_pct, baseline_usd, active, created_at, last_triggered_at
     FROM portfolio_alerts WHERE owner_wallet = $1 ORDER BY created_at DESC`,
    [ownerWallet.toLowerCase()]
  );
  return (res?.rows || []).map(normalizeRow);
}

/** Creates a portfolio %-move alert. `baselineUsd` is the live combined-portfolio USD value at
 * creation time (see portfolioValuation.js) — the caller (premiumAlertsRouter.js) resolves this
 * fresh and passes it in, same division of responsibility as addTokenPriceAlert. */
export async function addPortfolioAlert(ownerWallet, { direction, thresholdPct, baselineUsd }) {
  const owner = ownerWallet.toLowerCase();

  const countRes = await query(`SELECT count(*) FROM portfolio_alerts WHERE owner_wallet = $1 AND active`, [owner]);
  if (Number(countRes?.rows[0]?.count || 0) >= MAX_PORTFOLIO_ALERTS_PER_OWNER) {
    throw new Error(`You can have up to ${MAX_PORTFOLIO_ALERTS_PER_OWNER} active portfolio alerts — remove one first`);
  }

  const res = await query(
    `INSERT INTO portfolio_alerts (owner_wallet, direction, threshold_pct, baseline_usd)
     VALUES ($1, $2, $3, $4)
     RETURNING id, direction, threshold_pct, baseline_usd, active, created_at, last_triggered_at`,
    [owner, direction, thresholdPct, baselineUsd]
  );
  return normalizeRow(res.rows[0]);
}

/** Deletes one of `ownerWallet`'s own alerts — throws if it doesn't exist or belongs to someone
 * else. */
export async function removePortfolioAlert(ownerWallet, alertId) {
  const res = await query(
    `DELETE FROM portfolio_alerts WHERE id = $1 AND owner_wallet = $2 RETURNING id`,
    [alertId, ownerWallet.toLowerCase()]
  );
  if (!res?.rows[0]) {
    throw new Error("Alert not found");
  }
}

/** Every active portfolio_alerts row across every owner — portfolioAlertScheduler.js's own poll
 * shape: one portfolio valuation per owner, checked against that owner's own alert(s) (which may
 * differ in direction/threshold). */
export async function getAllActivePortfolioAlerts() {
  const res = await query(
    `SELECT id, owner_wallet, direction, threshold_pct, baseline_usd
     FROM portfolio_alerts WHERE active ORDER BY owner_wallet`
  );
  const byOwner = new Map();
  for (const r of res?.rows || []) {
    if (!byOwner.has(r.owner_wallet)) byOwner.set(r.owner_wallet, []);
    byOwner.get(r.owner_wallet).push({
      id: r.id,
      ownerWallet: r.owner_wallet,
      direction: r.direction,
      thresholdPct: Number(r.threshold_pct),
      baselineUsd: Number(r.baseline_usd),
    });
  }
  return byOwner;
}

/** Recurring reset (see the migration's own header comment): baseline resets to the value that
 * just triggered it, alert stays active. */
export async function resetPortfolioAlertBaseline(alertId, newBaselineUsd) {
  await query(
    `UPDATE portfolio_alerts SET baseline_usd = $2, last_triggered_at = now() WHERE id = $1`,
    [alertId, newBaselineUsd]
  );
}
