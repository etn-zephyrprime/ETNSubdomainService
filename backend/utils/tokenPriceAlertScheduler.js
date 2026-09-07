// backend/utils/tokenPriceAlertScheduler.js
//
// Polls every distinct token that has at least one active token_price_alerts row (see
// migrations/009_alerts.sql) and checks each alert's %-move condition against a live on-chain
// quote — see dexPriceQuote.js's own header comment for why that's a direct reserve read, not
// GeckoTerminal. USD-denominated alerts multiply that ETN-leg price by the live ETN/USD price
// (etnPriceCache.js's existing 5-minute-refreshed cache) rather than re-deriving USD from scratch —
// per the build brief, the two denominations are genuinely independent signals (a token can move
// against ETN while showing little/no USD change if ETN itself moved oppositely, and vice versa),
// so each alert's own `denomination` picks which one it's actually measuring, never converts one
// after the fact from the other's stored baseline.
//
// Recurring, not one-shot (confirmed decision): a fired alert's baseline_price resets to the price
// that just triggered it and the alert stays active — the next notification needs a fresh move
// from THAT point, which also happens to be exactly what prevents re-firing every single poll
// while the price sits past the old threshold.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getActiveTokenPriceAlertsByToken, resetTokenPriceAlertBaseline } from "../db/tokenPriceAlerts.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { getLinkedChatId } from "./telegramLinkRouter.js";
import { sendTelegramDirectMessage } from "./telegramNotifier.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getTokenMetadata } from "../services/pnlIngestion.js";

const CHECK_INTERVAL_MS = process.env.TOKEN_PRICE_ALERT_CHECK_INTERVAL_MS
  ? parseInt(process.env.TOKEN_PRICE_ALERT_CHECK_INTERVAL_MS, 10)
  : 3 * 60 * 1000; // cheap RPC reads, no shared external rate limit to protect — safe to poll fairly often
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";

function fmtPrice(v) {
  // Sub-cent token prices are common on this chain — enough precision to be meaningful without an
  // unreadable string of zeros for a "normal"-priced token.
  return v < 0.01 ? v.toFixed(8) : v.toFixed(4);
}

async function checkOneToken(provider, tokenAddress, alerts, etnUsd) {
  let etnPrice;
  try {
    etnPrice = await getTokenEtnPrice(provider, tokenAddress);
  } catch (err) {
    console.warn(`⚠️  Token price alert: quote failed for ${tokenAddress}:`, err.message);
    return;
  }
  if (etnPrice == null) return; // no direct WETN pair — nothing to evaluate against

  const usdPrice = etnUsd != null ? etnPrice * etnUsd : null;

  for (const alert of alerts) {
    const price = alert.denomination === "USD" ? usdPrice : etnPrice;
    if (price == null) continue; // USD alert but the ETN/USD cache isn't ready yet — try again next poll

    const pctMove = ((price - alert.baselinePrice) / alert.baselinePrice) * 100;
    const crossed = alert.direction === "up" ? pctMove >= alert.thresholdPct : pctMove <= -alert.thresholdPct;
    if (!crossed) continue;

    // Premium-only feature (confirmed decision) — a lapsed membership just pauses the alert in
    // place (no baseline reset, no notification) rather than deactivating or deleting it, so it
    // picks back up correctly if they resubscribe.
    if (!(await hasCoreAccess(alert.ownerWallet))) continue;

    const chatId = await getLinkedChatId(alert.ownerWallet);
    if (chatId != null) {
      const metadata = await getTokenMetadata(tokenAddress);
      const label = metadata?.symbol || metadata?.name || `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
      const arrow = pctMove >= 0 ? "📈" : "📉";
      const denomLabel = alert.denomination === "USD" ? "USD" : "ETN";
      const priceStr = alert.denomination === "USD" ? `$${fmtPrice(price)}` : `${fmtPrice(price)} ETN`;
      await sendTelegramDirectMessage(
        chatId,
        `${arrow} *${label}* is ${pctMove >= 0 ? "up" : "down"} ${Math.abs(pctMove).toFixed(1)}% (${denomLabel}) — now ${priceStr}\n\n` +
          `Alert: ${alert.direction} ${alert.thresholdPct}%\n\n[View on the dashboard](${DASHBOARD_URL}/premium)`
      );
    }

    // Reset regardless of delivery outcome (chatId missing, or the DM itself failing) — the price
    // move genuinely happened; a later Telegram link shouldn't cause a flood of stale notifications
    // for moves that occurred while unlinked.
    await resetTokenPriceAlertBaseline(alert.id, price);
  }
}

let isRunning = false;

async function checkAllTokens(provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const [byToken, priceCache] = await Promise.all([getActiveTokenPriceAlertsByToken(), getEtnPriceCache()]);
    const etnUsd = priceCache?.usd ?? null;

    for (const [tokenAddress, alerts] of byToken) {
      await checkOneToken(provider, tokenAddress, alerts, etnUsd);
    }
  } catch (err) {
    console.error("⚠️  Token price alert check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startTokenPriceAlertScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — token price alert scheduler disabled");
    return;
  }

  const provider = createRpcProvider();
  console.log(`🔔 Token price alert scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAllTokens(provider);
  setInterval(() => checkAllTokens(provider), CHECK_INTERVAL_MS);
}
