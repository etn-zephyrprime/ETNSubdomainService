// backend/utils/premiumDashboardRouter.js
//
// HTTP surface for Core tier — the first premium dashboard feature beyond PnL Statements: up to
// MAX_TRACKED_WALLETS wallets a member can track for the combined portfolio view (see
// src/dashboard/premium/components/CoreTierPortfolio.jsx). Both endpoints require the same signed
// proof of wallet ownership GET /pnl/statements uses (walletAuth.js) — keyed on nothing but a bare
// wallet address otherwise, same reasoning as that route's own comment — AND an active Core tier
// membership (hasCoreAccess: either PremiumSubscription tier, see premiumAccess.js). Mounted at
// /api/premium in backend/index.js.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getTrackedWallets, setTrackedWallets, MAX_TRACKED_WALLETS } from "../db/trackedWallets.js";

// Folded into the signed message (see walletAuth.js) — must stay a single literal shared by both
// routes below, since a lapsed-then-renewed member re-fetching and re-saving in the same session
// should be able to reuse one cached signature (see useWalletAuthSignature.js) across both calls.
const AUTH_PURPOSE = "Premium Dashboard";

const router = express.Router();

router.get("/premium/tracked-wallets", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }

  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const wallets = await getTrackedWallets(wallet);
  res.json({ wallets, maxWallets: MAX_TRACKED_WALLETS });
});

router.put("/premium/tracked-wallets", async (req, res) => {
  const { wallet, signature, timestamp, wallets } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }

  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  if (!Array.isArray(wallets)) {
    return res.status(400).json({ error: "wallets must be an array" });
  }
  if (wallets.length > MAX_TRACKED_WALLETS) {
    return res.status(400).json({ error: `Cannot track more than ${MAX_TRACKED_WALLETS} wallets` });
  }
  for (const w of wallets) {
    if (!ethers.isAddress(w)) return res.status(400).json({ error: `Invalid address: ${w}` });
  }

  const saved = await setTrackedWallets(wallet, wallets);
  res.json({ wallets: saved, maxWallets: MAX_TRACKED_WALLETS });
});

export default router;
