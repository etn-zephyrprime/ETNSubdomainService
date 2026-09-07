import { query } from "./pool.js";

/** Whether `ownerWallet` currently has the daily portfolio digest enabled. */
export async function getDigestSubscription(ownerWallet) {
  const res = await query(
    `SELECT enabled, last_sent_date, last_sent_total_usd FROM portfolio_digest_subscriptions WHERE owner_wallet = $1`,
    [ownerWallet.toLowerCase()]
  );
  const row = res?.rows[0];
  if (!row) return { enabled: false, lastSentDate: null, lastSentTotalUsd: null };
  return {
    enabled: row.enabled,
    lastSentDate: row.last_sent_date,
    lastSentTotalUsd: row.last_sent_total_usd != null ? Number(row.last_sent_total_usd) : null,
  };
}

/** Creates or flips the subscription row for `ownerWallet` — upsert rather than insert-or-throw
 * since toggling on/off/on again is the expected normal usage, not an edge case to guard against. */
export async function setDigestEnabled(ownerWallet, enabled) {
  await query(
    `INSERT INTO portfolio_digest_subscriptions (owner_wallet, enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (owner_wallet) DO UPDATE SET enabled = $2, updated_at = now()`,
    [ownerWallet.toLowerCase(), enabled]
  );
}

/** Every owner with the digest currently enabled — portfolioDigestScheduler.js's own poll list. */
export async function getEnabledDigestSubscriptions() {
  const res = await query(
    `SELECT owner_wallet, last_sent_date, last_sent_total_usd FROM portfolio_digest_subscriptions WHERE enabled`
  );
  return (res?.rows || []).map((r) => ({
    ownerWallet: r.owner_wallet,
    lastSentDate: r.last_sent_date,
    lastSentTotalUsd: r.last_sent_total_usd != null ? Number(r.last_sent_total_usd) : null,
  }));
}

/** Records that today's digest went out, and what it reported — tomorrow's digest diffs against
 * this value (see the migration's own header comment on why "since the last digest", not "since
 * midnight"). */
export async function recordDigestSent(ownerWallet, totalUsd, sentDate) {
  await query(
    `UPDATE portfolio_digest_subscriptions SET last_sent_date = $2, last_sent_total_usd = $3, updated_at = now() WHERE owner_wallet = $1`,
    [ownerWallet.toLowerCase(), sentDate, totalUsd]
  );
}
