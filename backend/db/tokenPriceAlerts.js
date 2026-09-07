import { query } from "./pool.js";

export const MAX_TOKEN_PRICE_ALERTS_PER_OWNER = 10;

function normalizeRow(r) {
  return {
    id: r.id,
    tokenAddress: r.token_address,
    direction: r.direction,
    thresholdPct: Number(r.threshold_pct),
    denomination: r.denomination,
    baselinePrice: Number(r.baseline_price),
    active: r.active,
    createdAt: r.created_at,
    lastTriggeredAt: r.last_triggered_at,
  };
}

/** Every token price alert (active or not) belonging to `ownerWallet`, newest first. */
export async function getTokenPriceAlerts(ownerWallet) {
  const res = await query(
    `SELECT id, token_address, direction, threshold_pct, denomination, baseline_price, active, created_at, last_triggered_at
     FROM token_price_alerts WHERE owner_wallet = $1 ORDER BY created_at DESC`,
    [ownerWallet.toLowerCase()]
  );
  return (res?.rows || []).map(normalizeRow);
}

/** Creates a token price-move alert. `baselinePrice` is the live price (in `denomination`) at the
 * moment of creation — see tokenPriceAlertScheduler.js/dexPriceQuote.js for how that's quoted;
 * this module just stores whatever the caller already resolved. */
export async function addTokenPriceAlert(ownerWallet, { tokenAddress, direction, thresholdPct, denomination, baselinePrice }) {
  const owner = ownerWallet.toLowerCase();

  const countRes = await query(`SELECT count(*) FROM token_price_alerts WHERE owner_wallet = $1 AND active`, [owner]);
  if (Number(countRes?.rows[0]?.count || 0) >= MAX_TOKEN_PRICE_ALERTS_PER_OWNER) {
    throw new Error(`You can have up to ${MAX_TOKEN_PRICE_ALERTS_PER_OWNER} active token price alerts — remove one first`);
  }

  const res = await query(
    `INSERT INTO token_price_alerts (owner_wallet, token_address, direction, threshold_pct, denomination, baseline_price)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, token_address, direction, threshold_pct, denomination, baseline_price, active, created_at, last_triggered_at`,
    [owner, tokenAddress.toLowerCase(), direction, thresholdPct, denomination, baselinePrice]
  );
  return normalizeRow(res.rows[0]);
}

/** Deletes one of `ownerWallet`'s own alerts — throws if it doesn't exist or belongs to someone
 * else. */
export async function removeTokenPriceAlert(ownerWallet, alertId) {
  const res = await query(
    `DELETE FROM token_price_alerts WHERE id = $1 AND owner_wallet = $2 RETURNING id`,
    [alertId, ownerWallet.toLowerCase()]
  );
  if (!res?.rows[0]) {
    throw new Error("Alert not found");
  }
}

/** Every active token_price_alerts row, grouped by token_address — tokenPriceAlertScheduler.js's
 * own per-poll access pattern: one live price quote per distinct token, checked against every
 * user's alert(s) on it (which may differ in direction/threshold/denomination), rather than one
 * quote per alert. */
export async function getActiveTokenPriceAlertsByToken() {
  const res = await query(
    `SELECT id, owner_wallet, token_address, direction, threshold_pct, denomination, baseline_price
     FROM token_price_alerts WHERE active ORDER BY token_address`
  );
  const byToken = new Map();
  for (const r of res?.rows || []) {
    if (!byToken.has(r.token_address)) byToken.set(r.token_address, []);
    byToken.get(r.token_address).push({
      id: r.id,
      ownerWallet: r.owner_wallet,
      tokenAddress: r.token_address,
      direction: r.direction,
      thresholdPct: Number(r.threshold_pct),
      denomination: r.denomination,
      baselinePrice: Number(r.baseline_price),
    });
  }
  return byToken;
}

/** Recurring reset (see the migration's own header comment): after firing, baseline_price becomes
 * the price that just triggered it, so the alert stays active and the next notification needs a
 * fresh move from there — never re-fires on the same still-crossed move. */
export async function resetTokenPriceAlertBaseline(alertId, newBaselinePrice) {
  await query(
    `UPDATE token_price_alerts SET baseline_price = $2, last_triggered_at = now() WHERE id = $1`,
    [alertId, newBaselinePrice]
  );
}
