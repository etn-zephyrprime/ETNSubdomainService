import { query } from "./pool.js";

// See migrations/018_portfolio_summary_cache.sql's own header comment.

/** `{ payload, computedAt }` or null if this member has never saved a summary. */
export async function getPortfolioSummary(ownerWallet) {
  const res = await query(`SELECT payload, computed_at FROM portfolio_summary_cache WHERE owner_wallet = $1`, [
    ownerWallet.toLowerCase(),
  ]);
  const row = res?.rows?.[0];
  return row ? { payload: row.payload, computedAt: row.computed_at } : null;
}

export async function upsertPortfolioSummary(ownerWallet, payload) {
  await query(
    `INSERT INTO portfolio_summary_cache (owner_wallet, payload, computed_at) VALUES ($1, $2, now())
     ON CONFLICT (owner_wallet) DO UPDATE SET payload = $2, computed_at = now()`,
    [ownerWallet.toLowerCase(), JSON.stringify(payload)]
  );
}
