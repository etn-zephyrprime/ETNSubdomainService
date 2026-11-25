import { query } from "./pool.js";

// Pre-payment cost-basis method choices (see migrations/038_statement_cost_model.sql). An intent
// only ever changes how a statement is calculated, never what gets paid or which period is bought.
// Intents expire after INTENT_TTL_HOURS so a choice made for an abandoned purchase can't silently
// apply to a much later one.
const INTENT_TTL_HOURS = 2;

export async function recordStatementOrderIntents({ payerWallet, trackedWallet, periods, costModel }) {
  for (const { periodType, year } of periods) {
    await query(
      `INSERT INTO statement_order_intents (payer_wallet, tracked_wallet, period_type, year, cost_model)
       VALUES ($1, $2, $3, $4, $5)`,
      [payerWallet.toLowerCase(), trackedWallet.toLowerCase(), periodType, year, costModel]
    );
  }
}

/** Latest live intent for this exact purchase, or null. Read-only; the caller consumes it only
 * once the matching statement request has actually been created. */
export async function findStatementOrderIntent({ payerWallet, trackedWallet, periodType, year }) {
  const res = await query(
    `SELECT id, cost_model FROM statement_order_intents
     WHERE payer_wallet = $1 AND tracked_wallet = $2 AND period_type = $3 AND year = $4
       AND consumed_at IS NULL
       AND created_at > now() - ($5 || ' hours')::interval
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [payerWallet.toLowerCase(), trackedWallet.toLowerCase(), periodType, year, String(INTENT_TTL_HOURS)]
  );
  return res?.rows[0] || null;
}

export async function markStatementOrderIntentConsumed(id) {
  await query(`UPDATE statement_order_intents SET consumed_at = now() WHERE id = $1`, [id]);
}
