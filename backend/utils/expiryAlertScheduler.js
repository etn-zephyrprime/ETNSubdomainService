// backend/utils/expiryAlertScheduler.js
//
// DMs a wallet — personally, via telegramLinkRouter.js's linked-chat lookup — when one of their
// activated domains or subnames is coming up on expiry. Deliberately personal-only, never posted
// to the public "Subdomain Name Service" channel the way sales are: broadcasting "X.etn expires
// in 3 days" publicly is exactly the tip-off a squatter wants, and the whole point of the linking
// feature this reuses (see telegramLinkRouter.js) was to make that kind of alert safe to send at
// all. A wallet that hasn't linked Telegram simply doesn't get these — no public fallback.
//
// Reads the already-published ownedNamesCache.js cache (every wrapped name + its expiry) rather
// than re-scanning/re-verifying anything on-chain itself — that cache already re-verifies
// owner/expiry for every entry on its own schedule (see its header comment), so this only ever
// needs to read, never write.
import { getOwnedNamesCache } from "../state/ownedNamesState.js";
import { getExpiryAlertState, setExpiryAlertState } from "../state/expiryAlertState.js";
import { getLinkedChatId, telegramLinkConfigured } from "./telegramLinkRouter.js";
import { sendTelegramDirectMessage } from "./telegramNotifier.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";
const CHECK_INTERVAL_MS = process.env.EXPIRY_ALERT_CHECK_INTERVAL_MS
  ? parseInt(process.env.EXPIRY_ALERT_CHECK_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000;

// Ascending, deduped, positive-integer days-before-expiry to warn at. A name gets DMed once per
// tier it crosses (30-day warning, then later a separate 7-day warning, then a separate 1-day
// warning) — never more than one per check cycle even if the service was asleep long enough to
// jump straight past an earlier tier unnoticed (see currentTier() below).
const TIER_DAYS = (process.env.EXPIRY_ALERT_TIER_DAYS || "30,7,1")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

// The smallest configured tier that `daysLeft` has already reached — e.g. with TIER_DAYS
// [1,7,30], a name 25 days out is in the "30" bucket, 5 days out is in the "7" bucket, and 0.5
// days out is in the "1" bucket. Monotonically shrinks as time passes, which is what makes "only
// send when the bucket has changed since last time" (see checkAndNotify) correct even across
// gaps in when this runs.
function currentTier(daysLeft) {
  return TIER_DAYS.find((t) => daysLeft <= t) ?? null;
}

let isRunning = false;

async function checkAndNotify() {
  if (isRunning) return; // previous check still in flight — skip this tick
  isRunning = true;
  try {
    const cache = await getOwnedNamesCache();
    const names = Array.isArray(cache?.names) ? cache.names : [];
    if (names.length === 0) return;

    const { sent } = await getExpiryAlertState();
    const maxTierDays = TIER_DAYS[TIER_DAYS.length - 1];
    const now = Date.now();
    let dirty = false;

    for (const entry of names) {
      if (!entry.expiry) continue;
      const daysLeft = (entry.expiry * 1000 - now) / ONE_DAY_MS;
      if (daysLeft < 0 || daysLeft > maxTierDays) continue; // already expired, or not close enough yet

      const tier = currentTier(daysLeft);
      const key = `${entry.node}:${entry.expiry}`;
      if (tier === null || sent[key] === tier) continue; // already warned for this exact tier+expiry

      const chatId = await getLinkedChatId(entry.owner);
      if (!chatId) continue; // not linked — leave unmarked so a later link still catches this tier

      const kind = entry.isSubname ? "Subname" : "Domain";
      const roundedDays = Math.max(0, Math.round(daysLeft));
      const whenText = roundedDays === 0 ? "today" : roundedDays === 1 ? "in 1 day" : `in ${roundedDays} days`;

      const result = await sendTelegramDirectMessage(
        chatId,
        `⏳ *${kind} Expiring ${whenText}*\n\n` +
        `\`${entry.name}\` expires ${whenText}. Renew it from "Manage & Resell" to keep it` +
        (entry.isSubname ? "." : " — and keep any subname buyers under it working.") +
        `\n\n[Renew on the site](${SITE_URL})`
      );

      // Only mark as sent on an actual successful DM — a transient Telegram API failure should
      // get retried next cycle, not silently treated as "already warned".
      if (result !== null) {
        sent[key] = tier;
        dirty = true;
      }
    }

    // Drop sent[] entries for nodes/expiries that no longer appear in the cache at all (expired
    // past every tier and aged out, or the node's expiry changed) — keeps this file bounded
    // instead of growing forever.
    const validKeys = new Set(names.filter((n) => n.expiry).map((n) => `${n.node}:${n.expiry}`));
    for (const key of Object.keys(sent)) {
      if (!validKeys.has(key)) {
        delete sent[key];
        dirty = true;
      }
    }

    if (dirty) await setExpiryAlertState({ sent });
  } catch (err) {
    console.error("⚠️  Expiry alert check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background checker. No-op if Telegram alerts aren't configured (no bot token, or no
 * R2 for either the owned-names cache this reads or the link state it depends on) — same
 * reasoning as this repo's other optional features.
 */
export function startExpiryAlertScheduler() {
  if (!telegramLinkConfigured()) {
    console.log("ℹ️  Telegram alerts not configured — expiry alert scheduler disabled");
    return;
  }

  console.log(`⏳ Expiry alert scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s, tiers: ${TIER_DAYS.join("/")} days)`);
  checkAndNotify();
  setInterval(checkAndNotify, CHECK_INTERVAL_MS);
}
