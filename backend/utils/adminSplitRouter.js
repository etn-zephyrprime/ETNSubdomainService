// backend/utils/adminSplitRouter.js
//
// Read-only quote endpoint behind the Argus admin "Split & Burn" button — returns the exact
// (amount, minCoreOut, deadline) triple a manual PremiumSubscription.executeSplitForPeriod call
// should use (same figures scripts/quoteSplitValues.js prints; same safe-sweep accounting
// (premiumSplitQuote.js computeSafeSplitAmount) subscriptionRevenueSweepScheduler.js uses on its timer). It executes NOTHING and holds no key:
// the admin's own wallet sends the transaction from the browser, and the contract itself only
// accepts it from operator() — this route is just the "how much is safe to split" calculator, gated
// so the escrow/owed figures it reads out of the database aren't public.
//
// Gate: signed proof of wallet ownership (walletAuth.js, same "Premium Dashboard" purpose every
// other Core tier route signs, so the cached signature is reused) AND the proven wallet must be the
// admin wallet below. Not a Core tier membership check — the admin isn't necessarily a member.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { quoteMinCoreOut, computeSafeSplitAmount } from "./premiumSplitQuote.js";

const AUTH_PURPOSE = "Premium Dashboard";
const ADMIN_WALLET = (process.env.ARGUS_ADMIN_WALLET || "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73").toLowerCase();
const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;

// Same defaults/env overrides as subscriptionRevenueSweepScheduler.js — a manual split should never
// be able to sweep more aggressively than the automatic one would.
const SLIPPAGE_BPS = BigInt(process.env.SUBSCRIPTION_SWEEP_SLIPPAGE_BPS || "500");
const SAFETY_MARGIN_ETN = process.env.SUBSCRIPTION_SWEEP_SAFETY_MARGIN_ETN || "10";
const DEADLINE_SECONDS = 600;

const ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
];

const router = express.Router();

router.get("/admin/split-quote", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (String(wallet).toLowerCase() !== ADMIN_WALLET) {
    return res.status(403).json({ error: "Admin wallet required" });
  }
  if (!PREMIUM_SUBSCRIPTION_ADDRESS || !getPool()) {
    return res.status(503).json({ error: "PREMIUM_SUBSCRIPTION_ADDRESS / DATABASE_URL not configured on the backend" });
  }

  try {
    const provider = createRpcProvider();
    const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);
    // Exact accounting shared with the automatic sweep — see computeSafeSplitAmount's own comment.
    // Throws a client-safe message when it can't be computed safely (watcher position unknown/too
    // far behind); that's surfaced as a 409 below rather than a generic failure.
    let safe;
    try {
      safe = await computeSafeSplitAmount(provider, PREMIUM_SUBSCRIPTION_ADDRESS, { safetyMarginWei: ethers.parseEther(SAFETY_MARGIN_ETN) });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    const { balance, owed, owedDb, unrecorded, safetyMarginWei, amount } = safe;
    const operator = await contract.operator();
    const minCoreOut = amount > 0n ? await quoteMinCoreOut(contract, provider, amount, SLIPPAGE_BPS) : 0n;

    // Everything as decimal strings — these are uint256s, never JSON numbers.
    res.json({
      contractAddress: PREMIUM_SUBSCRIPTION_ADDRESS,
      operator,
      balance: balance.toString(),
      owedRecorded: owedDb.toString(),
      owedUnrecorded: unrecorded.toString(),
      owed: owed.toString(),
      safetyMargin: safetyMarginWei.toString(),
      amount: amount.toString(),
      minCoreOut: minCoreOut.toString(),
      deadline: String(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
    });
  } catch (err) {
    console.error("Admin split quote failed:", err);
    res.status(502).json({ error: "Couldn't compute the split quote right now — try again shortly" });
  }
});

export default router;
