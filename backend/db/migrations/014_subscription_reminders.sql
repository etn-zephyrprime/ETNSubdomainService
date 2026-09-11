-- Core tier premium feature: opt-in Telegram reminder when a member's own Core Tier membership
-- is coming up on expiry (subscriptionReminderScheduler.js) — same "plain on/off toggle, nothing
-- per-alert to configure" shape as portfolio_digest_subscriptions (010_portfolio_alerts.sql),
-- since a subscription only ever has one expiry to warn about, not a list a member builds up.
--
-- last_reminder_tier_days + last_reminder_expiry together are the dedup key: a given (owner,
-- expiry) pair only ever gets ONE reminder per tier (e.g. the 7-day warning fires once, not every
-- check cycle) — same reasoning expiryAlertScheduler.js's own sent[] map gives for domain expiry,
-- just two plain columns here since this is one row per owner, not per name. Storing the expiry
-- alongside the tier (not just the tier alone) is what makes a RENEWAL correctly reset this: a
-- renewal changes premium_memberships' own expiry timestamp, so last_reminder_expiry no longer
-- matches the current one, and the dedup check naturally treats it as a fresh cycle rather than
-- staying suppressed until some future tier.
CREATE TABLE IF NOT EXISTS subscription_reminder_subscriptions (
  owner_wallet TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_reminder_tier_days INTEGER,
  last_reminder_expiry TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
