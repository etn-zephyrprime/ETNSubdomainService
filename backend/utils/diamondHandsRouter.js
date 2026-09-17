// backend/utils/diamondHandsRouter.js
//
// HTTP surface for Core tier's Diamond Hands Score — see diamondHandsService.js's own header
// comment for what this is (a holding-BEHAVIOR score, not a PnL figure) and its full methodology.
// Same auth shape as every other Core tier router: signed proof of wallet ownership
// (walletAuth.js) plus an active Core tier membership (hasCoreAccess). Mounted at /api/premium in
// backend/index.js, alongside pnlSnapshotRouter.js/premiumDashboardRouter.js/premiumAlertsRouter.js.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { computeDiamondHandsScore } from "../services/diamondHandsService.js";

// Same literal every Core tier endpoint signs — one cached signature (useWalletAuthSignature.js)
// covers all of them, this one included.
const AUTH_PURPOSE = "Premium Dashboard";

function requireAuthAndAccess(req, res, wallet, signature, timestamp) {
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
    return true;
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
}

const router = express.Router();

// Full result — portfolio-level (pooled across every covered wallet), per-wallet, and per-asset —
// in one call, computed live (never cached/frozen here, same "not a formal record" treatment as
// /premium/pnl-snapshot). A member with several tracked wallets and real history should expect
// this to take real time, the same order of magnitude as the live PnL snapshot endpoint, since it
// replays the exact same FIFO ledger for each wallet plus the panic-sell price-history reads on
// top of that.
router.get("/premium/diamond-hands", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ asOf: new Date(), portfolio: { components: {}, score: null, tier: null }, perWallet: [], perAsset: [], failed: [] });
  }

  try {
    const result = await computeDiamondHandsScore(active.map((w) => w.address));
    res.json(result);
  } catch (err) {
    console.error("Diamond Hands score computation failed:", err);
    res.status(502).json({ error: "Couldn't compute your Diamond Hands score right now — try again shortly" });
  }
});

export default router;
