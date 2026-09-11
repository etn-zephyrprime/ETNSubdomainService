import { query } from "./pool.js";

// Same shape as portfolioDigestSubscriptions.js — a plain per-owner on/off toggle, no per-alert
// config, see migrations/014_subscription_reminders.sql for why.

/** Whether `ownerWallet` currently has Core Tier expiry reminders enabled. */
export async function getReminderSubscription(ownerWallet) {
  const res = await query(
    `SELECT enabled, last_reminder_tier_days, last_reminder_expiry FROM subscription_reminder_subscriptions WHERE owner_wallet = $1`,
    [ownerWallet.toLowerCase()]
  );
  const row = res?.rows[0];
  if (!row) return { enabled: false, lastReminderTierDays: null, lastReminderExpiry: null };
  return {
    enabled: row.enabled,
    lastReminderTierDays: row.last_reminder_tier_days,
    lastReminderExpiry: row.last_reminder_expiry,
  };
}

/** Creates or flips the subscription row for `ownerWallet` — upsert rather than insert-or-throw,
 * same reasoning as setDigestEnabled: toggling on/off/on again is the expected normal usage. */
export async function setReminderEnabled(ownerWallet, enabled) {
  await query(
    `INSERT INTO subscription_reminder_subscriptions (owner_wallet, enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (owner_wallet) DO UPDATE SET enabled = $2, updated_at = now()`,
    [ownerWallet.toLowerCase(), enabled]
  );
}

/** Every owner with reminders currently enabled — subscriptionReminderScheduler.js's own poll list. */
export async function getEnabledReminderSubscriptions() {
  const res = await query(
    `SELECT owner_wallet, last_reminder_tier_days, last_reminder_expiry FROM subscription_reminder_subscriptions WHERE enabled`
  );
  return (res?.rows || []).map((r) => ({
    ownerWallet: r.owner_wallet,
    lastReminderTierDays: r.last_reminder_tier_days,
    lastReminderExpiry: r.last_reminder_expiry,
  }));
}

/** Records that a reminder went out for this (owner, tier, expiry) — the dedup key the scheduler
 * checks before sending again. See the migration's own header comment on why storing the expiry
 * alongside the tier is what makes a renewal correctly reset this. */
export async function recordReminderSent(ownerWallet, tierDays, expiry) {
  await query(
    `UPDATE subscription_reminder_subscriptions SET last_reminder_tier_days = $2, last_reminder_expiry = $3, updated_at = now() WHERE owner_wallet = $1`,
    [ownerWallet.toLowerCase(), tierDays, expiry]
  );
}
