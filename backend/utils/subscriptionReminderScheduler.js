// backend/utils/subscriptionReminderScheduler.js
//
// DMs a member — via the Planet Zephyros Notis bot (same delivery as every other Core tier alert,
// see notisLinkRouter.js) — when their Core Tier membership is coming up on expiry. Opt-in
// (subscription_reminder_subscriptions), same "plain toggle, nothing per-alert to configure" shape
// as the daily portfolio digest (portfolioDigestScheduler.js), since there's nothing to configure
// beyond on/off — a member only ever has one membership expiry to warn about.
//
// A member can hold monthly and/or annual membership independently (see premiumAccess.js's own
// header comment on why hasCoreAccess accepts either) — this reminder tracks whichever expiry is
// the LATER of the two, since that's the one that actually determines when Core tier access ends.
import { getPool, query } from "../db/pool.js";
import { getEnabledReminderSubscriptions, recordReminderSent } from "../db/subscriptionReminderSubscriptions.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
// Once a day is plenty — an expiry timestamp doesn't move minute to minute, unlike the
// value-based alerts elsewhere in this backend that need tighter polling.
const CHECK_INTERVAL_MS = process.env.SUBSCRIPTION_REMINDER_CHECK_INTERVAL_MS
  ? parseInt(process.env.SUBSCRIPTION_REMINDER_CHECK_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000;

// Ascending, deduped, positive-integer days-before-expiry to warn at — same "tier" convention as
// expiryAlertScheduler.js's own TIER_DAYS, tightened for a monthly-cadence product rather than
// domain registrations' yearly one.
const TIER_DAYS = (process.env.SUBSCRIPTION_REMINDER_TIER_DAYS || "7,3,1")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

// Same "smallest tier already reached" logic as expiryAlertScheduler.js's own currentTier.
function currentTier(daysLeft) {
  return TIER_DAYS.find((t) => daysLeft <= t) ?? null;
}

/** The later of monthly_expiry/annual_expiry for this owner, or null if they've never held either
 * (a row here with nothing in premium_memberships shouldn't happen in practice, but isn't an
 * error — just nothing to remind about yet). Deliberately not gated on "still active" the way
 * hasCoreAccess is: an already-lapsed expiry still needs its tiers to have fired ON TIME, before
 * it lapsed — by the time daysLeft is negative this loop's own check below skips it anyway. */
async function getEffectiveExpiry(ownerWallet) {
  const res = await query(`SELECT monthly_expiry, annual_expiry FROM premium_memberships WHERE wallet_address = $1`, [
    ownerWallet.toLowerCase(),
  ]);
  const row = res?.rows[0];
  if (!row) return null;
  const candidates = [row.monthly_expiry, row.annual_expiry].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, d) => (new Date(d) > new Date(latest) ? d : latest));
}

let isRunning = false;

async function checkAllOwners() {
  if (isRunning) return;
  isRunning = true;
  try {
    const subs = await getEnabledReminderSubscriptions();
    if (subs.length === 0) return;

    const now = Date.now();
    const maxTierDays = TIER_DAYS[TIER_DAYS.length - 1];

    for (const sub of subs) {
      const expiry = await getEffectiveExpiry(sub.ownerWallet);
      if (!expiry) continue; // never actually subscribed — nothing to warn about

      const expiryMs = new Date(expiry).getTime();
      const daysLeft = (expiryMs - now) / ONE_DAY_MS;
      if (daysLeft < 0 || daysLeft > maxTierDays) continue; // already expired, or not close enough yet

      const tier = currentTier(daysLeft);
      // See migration 014's own comment: a renewal changes `expiry`, so a tier already sent
      // against the OLD expiry doesn't suppress a fresh warning against the NEW one.
      const sameExpiry = sub.lastReminderExpiry && new Date(sub.lastReminderExpiry).getTime() === expiryMs;
      if (tier === null || (sameExpiry && sub.lastReminderTierDays === tier)) continue;

      const chatId = await getNotisLinkedChatId(sub.ownerWallet);
      if (!chatId) continue; // not linked — leave unmarked so a later link still catches this tier

      const roundedDays = Math.max(0, Math.round(daysLeft));
      const whenText = roundedDays === 0 ? "today" : roundedDays === 1 ? "in 1 day" : `in ${roundedDays} days`;

      // Only mark as sent on an actual successful DM — same reasoning expiryAlertScheduler.js
      // gives: a transient Telegram API failure should get retried next cycle, not silently
      // treated as "already warned".
      const result = await sendNotisDirectMessage(
        chatId,
        `⏳ *Core Tier membership expiring ${whenText}*\n\n` +
          `Renew from the Premium tab to keep your tracked wallets, PnL history, and Telegram alerts running without a gap.\n\n` +
          `[Renew](${DASHBOARD_URL}/premium)`
      );

      if (result !== null) {
        await recordReminderSent(sub.ownerWallet, tier, expiry);
      }
    }
  } catch (err) {
    console.error("⚠️  Subscription reminder check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startSubscriptionReminderScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — subscription reminder scheduler disabled");
    return;
  }

  console.log(`⏳ Subscription reminder scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s, tiers: ${TIER_DAYS.join("/")} days)`);
  checkAllOwners();
  setInterval(checkAllOwners, CHECK_INTERVAL_MS);
}
