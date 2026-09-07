// backend/utils/premiumAlertsRouter.js
//
// HTTP surface for Core tier's Telegram alerts (wallet balance/activity + token price moves) — see
// migrations/009_alerts.sql, walletAlertScheduler.js, tokenPriceAlertScheduler.js. Same auth shape
// as premiumDashboardRouter.js: signed proof of wallet ownership (walletAuth.js) plus an active
// Core tier membership (hasCoreAccess) on every route. Mounted at /api/premium in
// backend/index.js, alongside that router.
//
// Telegram LINKING itself is deliberately not here — /api/telegram/* (telegramLinkRouter.js)
// already covers it, keyed on the exact same wallet address every premium endpoint already
// authenticates. Reused as-is, not duplicated.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getActiveTrackedWallets } from "../db/trackedWallets.js";
import { getWalletAlerts, addWalletAlert, removeWalletAlert, MAX_WALLET_ALERTS_PER_OWNER } from "../db/walletAlerts.js";
import { getTokenPriceAlerts, addTokenPriceAlert, removeTokenPriceAlert, MAX_TOKEN_PRICE_ALERTS_PER_OWNER } from "../db/tokenPriceAlerts.js";
import { getPortfolioAlerts, addPortfolioAlert, removePortfolioAlert, MAX_PORTFOLIO_ALERTS_PER_OWNER } from "../db/portfolioAlerts.js";
import { getDigestSubscription, setDigestEnabled } from "../db/portfolioDigestSubscriptions.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getPortfolioUsdValue } from "./portfolioValuation.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { createRpcProvider } from "./rpcProvider.js";
import { EXPLORER_BASE_URL } from "../services/pnlIngestion.js";

const AUTH_PURPOSE = "Premium Dashboard"; // same literal premiumDashboardRouter.js uses — a cached signature works across both
const provider = createRpcProvider();

function requireAuthAndAccess(req, res, wallet, signature, timestamp) {
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
    return true;
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
}

async function requireCoreAccess(res, wallet) {
  if (!(await hasCoreAccess(wallet))) {
    res.status(403).json({ error: "Core tier membership required" });
    return false;
  }
  return true;
}

/** The wallet's current newest transaction hash, or null (no history yet / lookup failed) — used
 * only to seed a fresh tx_activity alert's cursor so it starts watching from "now", never the
 * wallet's entire past. A failed lookup here just means the alert starts from null (equivalent to
 * "never seen anything yet"), which is the same starting state a genuinely brand-new wallet gets —
 * safe to fall through rather than fail the whole request over a transient fetch error. */
async function fetchNewestTxHash(walletAddress) {
  try {
    const res = await fetch(`${EXPLORER_BASE_URL}/api/v2/addresses/${walletAddress}/transactions`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.items?.[0]?.hash || null;
  } catch {
    return null;
  }
}

const router = express.Router();

// ---- Wallet alerts (balance threshold + tx activity) ----

router.get("/premium/wallet-alerts", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  const alerts = await getWalletAlerts(wallet);
  res.json({ alerts, maxAlerts: MAX_WALLET_ALERTS_PER_OWNER });
});

router.post("/premium/wallet-alerts", async (req, res) => {
  const { wallet, signature, timestamp, walletAddress, alertType, direction, thresholdValue, denomination } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: "walletAddress must be a valid address" });
  }
  if (!["balance_threshold", "tx_activity"].includes(alertType)) {
    return res.status(400).json({ error: "alertType must be balance_threshold or tx_activity" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  const active = await getActiveTrackedWallets(wallet);
  if (!active.some((w) => w.address === walletAddress.toLowerCase())) {
    return res.status(400).json({ error: "You can only set alerts on wallets you're actively tracking" });
  }

  try {
    let payload;
    if (alertType === "balance_threshold") {
      if (!["above", "below"].includes(direction)) {
        return res.status(400).json({ error: "direction must be above or below" });
      }
      const value = Number(thresholdValue);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: "thresholdValue must be a non-negative number" });
      }
      const denom = denomination === "ETN" ? "ETN" : denomination;
      if (denom !== "ETN" && !ethers.isAddress(denom)) {
        return res.status(400).json({ error: "denomination must be ETN or a token address" });
      }
      payload = {
        walletAddress,
        alertType,
        direction,
        thresholdValue: value,
        denomination: denom === "ETN" ? "ETN" : denom.toLowerCase(),
        seedLastTxHash: null,
      };
    } else {
      let minAmount = null;
      if (thresholdValue != null && thresholdValue !== "") {
        minAmount = Number(thresholdValue);
        if (!Number.isFinite(minAmount) || minAmount < 0) {
          return res.status(400).json({ error: "thresholdValue (minimum amount) must be a non-negative number" });
        }
      }
      payload = {
        walletAddress,
        alertType,
        direction: null,
        thresholdValue: minAmount,
        denomination: null,
        seedLastTxHash: await fetchNewestTxHash(walletAddress.toLowerCase()),
      };
    }

    const alert = await addWalletAlert(wallet, payload);
    res.json({ alert, maxAlerts: MAX_WALLET_ALERTS_PER_OWNER });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/premium/wallet-alerts", async (req, res) => {
  const { wallet, signature, timestamp, alertId } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!alertId) {
    return res.status(400).json({ error: "alertId is required" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  try {
    await removeWalletAlert(wallet, alertId);
    res.json({ removed: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---- Token price alerts ----

router.get("/premium/token-alerts", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  const alerts = await getTokenPriceAlerts(wallet);
  res.json({ alerts, maxAlerts: MAX_TOKEN_PRICE_ALERTS_PER_OWNER });
});

router.post("/premium/token-alerts", async (req, res) => {
  const { wallet, signature, timestamp, tokenAddress, direction, thresholdPct, denomination } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return res.status(400).json({ error: "tokenAddress must be a valid address" });
  }
  if (!["up", "down"].includes(direction)) {
    return res.status(400).json({ error: "direction must be up or down" });
  }
  if (!["USD", "ETN"].includes(denomination)) {
    return res.status(400).json({ error: "denomination must be USD or ETN" });
  }
  const pct = Number(thresholdPct);
  if (!Number.isFinite(pct) || pct <= 0) {
    return res.status(400).json({ error: "thresholdPct must be a positive number" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  let etnPrice;
  try {
    etnPrice = await getTokenEtnPrice(provider, tokenAddress);
  } catch (err) {
    return res.status(502).json({ error: `Couldn't quote a live price for that token: ${err.message}` });
  }
  if (etnPrice == null) {
    return res.status(400).json({ error: "No ElectroSwap pool found for this token — can't set a price alert on it" });
  }

  let baselinePrice = etnPrice;
  if (denomination === "USD") {
    const priceCache = await getEtnPriceCache();
    if (priceCache?.usd == null) {
      return res.status(503).json({ error: "ETN/USD price isn't available yet — try again shortly" });
    }
    baselinePrice = etnPrice * priceCache.usd;
  }

  try {
    const alert = await addTokenPriceAlert(wallet, { tokenAddress, direction, thresholdPct: pct, denomination, baselinePrice });
    res.json({ alert, maxAlerts: MAX_TOKEN_PRICE_ALERTS_PER_OWNER });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/premium/token-alerts", async (req, res) => {
  const { wallet, signature, timestamp, alertId } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!alertId) {
    return res.status(400).json({ error: "alertId is required" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  try {
    await removeTokenPriceAlert(wallet, alertId);
    res.json({ removed: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---- Portfolio alerts (combined tracked-wallet USD %-move) ----

router.get("/premium/portfolio-alerts", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  const alerts = await getPortfolioAlerts(wallet);
  res.json({ alerts, maxAlerts: MAX_PORTFOLIO_ALERTS_PER_OWNER });
});

router.post("/premium/portfolio-alerts", async (req, res) => {
  const { wallet, signature, timestamp, direction, thresholdPct } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!["up", "down"].includes(direction)) {
    return res.status(400).json({ error: "direction must be up or down" });
  }
  const pct = Number(thresholdPct);
  if (!Number.isFinite(pct) || pct <= 0) {
    return res.status(400).json({ error: "thresholdPct must be a positive number" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  let totalUsd;
  try {
    ({ totalUsd } = await getPortfolioUsdValue(provider, wallet));
  } catch (err) {
    return res.status(502).json({ error: `Couldn't value your portfolio right now: ${err.message}` });
  }
  if (totalUsd <= 0) {
    return res.status(400).json({ error: "Your tracked wallets don't have a priced balance yet — track a wallet with a real ETN/token balance first" });
  }

  try {
    const alert = await addPortfolioAlert(wallet, { direction, thresholdPct: pct, baselineUsd: totalUsd });
    res.json({ alert, maxAlerts: MAX_PORTFOLIO_ALERTS_PER_OWNER });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/premium/portfolio-alerts", async (req, res) => {
  const { wallet, signature, timestamp, alertId } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!alertId) {
    return res.status(400).json({ error: "alertId is required" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  try {
    await removePortfolioAlert(wallet, alertId);
    res.json({ removed: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---- Daily portfolio digest (opt-in toggle, no per-alert config) ----

router.get("/premium/portfolio-digest", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  const sub = await getDigestSubscription(wallet);
  res.json(sub);
});

router.post("/premium/portfolio-digest", async (req, res) => {
  const { wallet, signature, timestamp, enabled } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await requireCoreAccess(res, wallet))) return;

  await setDigestEnabled(wallet, enabled);
  const sub = await getDigestSubscription(wallet);
  res.json(sub);
});

export default router;
