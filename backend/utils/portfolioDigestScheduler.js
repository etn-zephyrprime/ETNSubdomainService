// backend/utils/portfolioDigestScheduler.js
//
// Opt-in daily DM: total combined tracked-wallet USD value, and the change since the last digest
// (see migrations/010_portfolio_alerts.sql's own header comment for why "since the last digest"
// rather than "since midnight" — it's a more honest comparison when a digest is ever missed or a
// member enables it mid-day). Ticks frequently (CHECK_INTERVAL_MS) but only actually sends once a
// UTC calendar day has passed since the last send AND the configured hour has arrived — the
// frequent tick is just a cheap DB read for anyone not yet due, not a real cost.
//
// Reuses portfolioValuation.js — the exact same "what is this portfolio worth" computation
// portfolioAlertScheduler.js's threshold alerts use, so the two features can never disagree.
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getEnabledDigestSubscriptions, recordDigestSent } from "../db/portfolioDigestSubscriptions.js";
import { getPortfolioUsdValue } from "./portfolioValuation.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";

const CHECK_INTERVAL_MS = process.env.PORTFOLIO_DIGEST_CHECK_INTERVAL_MS
  ? parseInt(process.env.PORTFOLIO_DIGEST_CHECK_INTERVAL_MS, 10)
  : 20 * 60 * 1000;
// UTC hour the digest goes out at (0-23) — deliberately a single fixed hour for everyone rather
// than per-member timezone preferences, same "keep v1 simple" spirit as every other default in
// this feature. Default picked to land in the late morning across the Americas/Europe without
// being the middle of the night in Asia-Pacific timezones either — a reasonable global compromise,
// not a precisely researched choice.
const DIGEST_HOUR_UTC = process.env.PORTFOLIO_DIGEST_HOUR_UTC ? parseInt(process.env.PORTFOLIO_DIGEST_HOUR_UTC, 10) : 12;
// A valuation that couldn't price/read everything is NOT a number worth reporting or comparing against: it
// used to be sent (and stored as tomorrow's baseline) as-is, so one rate-limited price lookup made the "total"
// drop by thousands and then jump back the next day. Now an incomplete valuation is retried on every tick
// (every CHECK_INTERVAL_MS) until it comes back complete; only if it is STILL incomplete at this UTC hour is it
// sent anyway — marked "≈", with no comparison line, and without touching the stored baseline.
const GIVE_UP_HOUR_UTC = process.env.PORTFOLIO_DIGEST_GIVE_UP_HOUR_UTC ? parseInt(process.env.PORTFOLIO_DIGEST_GIVE_UP_HOUR_UTC, 10) : 20;
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}
function toDateString(d) {
  if (!d) return null;
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}
function fmtUsd(v) {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function checkOneSubscription(provider, sub, today) {
  if (toDateString(sub.lastSentDate) === today) return; // already sent today
  if (!(await hasCoreAccess(sub.ownerWallet))) return; // premium-only, same as every other Core tier alert

  const tracked = await getCoveredWallets(sub.ownerWallet);
  if (tracked.length === 0) return; // defensive only — getCoveredWallets always includes the owner's own wallet now, so this is effectively unreachable

  const chatId = await getNotisLinkedChatId(sub.ownerWallet);
  if (chatId == null) return; // not linked — retried every tick until they link, so nothing is lost by not recording a send

  let totalUsd, hasUnpriced, usedStale;
  try {
    ({ totalUsd, hasUnpriced, usedStale } = await getPortfolioUsdValue(provider, sub.ownerWallet));
  } catch (err) {
    console.warn(`⚠️  Portfolio digest: valuation failed for ${sub.ownerWallet}:`, err.message);
    return;
  }

  if (hasUnpriced && new Date().getUTCHours() < GIVE_UP_HOUR_UTC) {
    console.warn(`⚠️  Portfolio digest: valuation for ${sub.ownerWallet} is incomplete (some holdings couldn't be priced) — holding the digest and retrying next check`);
    return; // nothing recorded, so the next tick tries again
  }

  const prefix = hasUnpriced ? "≈ " : "";
  let changeLine = "_First digest — no prior comparison yet._";
  if (hasUnpriced) {
    changeLine = "_No comparison today — some holdings couldn't be priced._";
  } else if (sub.lastSentTotalUsd != null) {
    const changeUsd = totalUsd - sub.lastSentTotalUsd;
    const changePct = sub.lastSentTotalUsd > 0 ? (changeUsd / sub.lastSentTotalUsd) * 100 : null;
    const arrow = changeUsd >= 0 ? "📈" : "📉";
    const pctStr = changePct != null ? ` (${changeUsd >= 0 ? "+" : ""}${changePct.toFixed(1)}%)` : "";
    changeLine = `${arrow} ${changeUsd >= 0 ? "+" : ""}${fmtUsd(changeUsd)}${pctStr} since your last digest`;
  }

  await sendNotisDirectMessage(
    chatId,
    `📊 *Daily Portfolio Summary*\n\n${prefix}${fmtUsd(totalUsd)}\n\n${changeLine}` +
      `${hasUnpriced ? "\n\n_Some holdings couldn't be priced — real total may be higher._" : ""}` +
      `${usedStale ? "\n\n_A few prices are from a recent snapshot._" : ""}\n\n` +
      `[Dashboard](${DASHBOARD_URL}/premium)`
  );

  // Only a COMPLETE total becomes tomorrow's comparison baseline; an incomplete one just marks today as sent.
  await recordDigestSent(sub.ownerWallet, hasUnpriced ? null : totalUsd, today);
}

let isRunning = false;

async function checkAllSubscriptions(provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    if (now.getUTCHours() < DIGEST_HOUR_UTC) return; // not yet today's send window
    const today = todayUtcDateString();

    const subs = await getEnabledDigestSubscriptions();
    for (const sub of subs) {
      await checkOneSubscription(provider, sub, today);
    }
  } catch (err) {
    console.error("⚠️  Portfolio digest check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startPortfolioDigestScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — portfolio digest scheduler disabled");
    return;
  }

  const provider = createRpcProvider();
  console.log(`📊 Portfolio digest scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s, sends at ${DIGEST_HOUR_UTC}:00 UTC)`);
  checkAllSubscriptions(provider);
  setInterval(() => checkAllSubscriptions(provider), CHECK_INTERVAL_MS);
}
