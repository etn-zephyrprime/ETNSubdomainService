// backend/utils/portfolioAlertScheduler.js
//
// Polls every member with at least one active portfolio_alerts row (see
// migrations/010_portfolio_alerts.sql) and checks their combined tracked-wallet USD value (see
// portfolioValuation.js) against each alert's own baseline. USD-only (unlike token price alerts'
// USD/ETN choice) — a member's PORTFOLIO is a basket of ETN and various tokens, so "value in ETN
// terms" isn't a well-defined single number the way one token's own ETN price is; USD is the only
// denomination that actually lets heterogeneous holdings be summed at all (see
// CoreTierPortfolio.jsx's own Total Portfolio Balance section, which this reuses the exact pricing
// logic of).
//
// Recurring, not one-shot (same confirmed decision as every other Core tier alert type):
// baseline_usd resets to the value that just triggered it, alert stays active.
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getAllActivePortfolioAlerts, resetPortfolioAlertBaseline } from "../db/portfolioAlerts.js";
import { getPortfolioUsdValue } from "./portfolioValuation.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";

const CHECK_INTERVAL_MS = process.env.PORTFOLIO_ALERT_CHECK_INTERVAL_MS
  ? parseInt(process.env.PORTFOLIO_ALERT_CHECK_INTERVAL_MS, 10)
  : 15 * 60 * 1000; // a full portfolio valuation (every tracked wallet's every token) is heavier than one wallet's balance — a bit less frequent than walletAlertScheduler.js's default
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";

function fmtUsd(v) {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function checkOneOwner(provider, ownerWallet, alerts) {
  if (!(await hasCoreAccess(ownerWallet))) return; // premium-only, same as every other Core tier alert — a lapsed membership just pauses these in place

  let totalUsd, hasUnpriced;
  try {
    ({ totalUsd, hasUnpriced } = await getPortfolioUsdValue(provider, ownerWallet));
  } catch (err) {
    console.warn(`⚠️  Portfolio alert: valuation failed for ${ownerWallet}:`, err.message);
    return;
  }

  for (const alert of alerts) {
    if (alert.baselineUsd <= 0) continue; // can't compute a % move off a zero baseline — avoid a divide-by-zero/Infinity
    const pctMove = ((totalUsd - alert.baselineUsd) / alert.baselineUsd) * 100;
    const crossed = alert.direction === "up" ? pctMove >= alert.thresholdPct : pctMove <= -alert.thresholdPct;
    if (!crossed) continue;

    const chatId = await getNotisLinkedChatId(ownerWallet);
    if (chatId != null) {
      const arrow = pctMove >= 0 ? "📈" : "📉";
      const changeUsd = totalUsd - alert.baselineUsd;
      const prefix = hasUnpriced ? "≈ " : "";
      await sendNotisDirectMessage(
        chatId,
        `${arrow} Your portfolio is ${pctMove >= 0 ? "up" : "down"} ${Math.abs(pctMove).toFixed(1)}% — now ${prefix}${fmtUsd(totalUsd)} (${changeUsd >= 0 ? "+" : ""}${fmtUsd(changeUsd)})\n\n` +
          `Alert: ${alert.direction} ${alert.thresholdPct}%${hasUnpriced ? "\n\n_Some holdings couldn't be priced — real total may be higher._" : ""}\n\n` +
          `[Dashboard](${DASHBOARD_URL}/premium)`
      );
    }

    // Reset regardless of delivery outcome — same reasoning as tokenPriceAlertScheduler.js's own
    // baseline reset: the move genuinely happened, a later Telegram link shouldn't cause a flood
    // of stale notifications.
    await resetPortfolioAlertBaseline(alert.id, totalUsd);
  }
}

let isRunning = false;

async function checkAllOwners(provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const byOwner = await getAllActivePortfolioAlerts();
    for (const [ownerWallet, alerts] of byOwner) {
      await checkOneOwner(provider, ownerWallet, alerts);
    }
  } catch (err) {
    console.error("⚠️  Portfolio alert check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startPortfolioAlertScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — portfolio alert scheduler disabled");
    return;
  }

  const provider = createRpcProvider();
  console.log(`🔔 Portfolio alert scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAllOwners(provider);
  setInterval(() => checkAllOwners(provider), CHECK_INTERVAL_MS);
}
