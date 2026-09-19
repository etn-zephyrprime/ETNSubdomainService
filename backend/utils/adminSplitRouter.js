// backend/utils/adminSplitRouter.js
//
// Read-only quote endpoint behind the Argus admin "Split & Burn" button — returns the exact
// (amount, minCoreOut, deadline) triple a manual PremiumSubscription.executeSplitForPeriod call
// should use (same figures scripts/quoteSplitValues.js prints; same safe-sweep formula
// subscriptionRevenueSweepScheduler.js uses on its timer). It executes NOTHING and holds no key:
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
import { getTotalPnlEscrowOwed } from "../db/statementRequests.js";
import { getPremiumSubscriptionWatcherState } from "../state/premiumSubscriptionWatcherState.js";
import { quoteMinCoreOut } from "./premiumSplitQuote.js";

const AUTH_PURPOSE = "Premium Dashboard";
const ADMIN_WALLET = (process.env.ARGUS_ADMIN_WALLET || "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73").toLowerCase();
const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;

// Same defaults/env overrides as subscriptionRevenueSweepScheduler.js — a manual split should never
// be able to sweep more aggressively than the automatic one would.
const SLIPPAGE_BPS = BigInt(process.env.SUBSCRIPTION_SWEEP_SLIPPAGE_BPS || "500");
const SAFETY_BUFFER_MULTIPLIER = process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER
  ? BigInt(process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER)
  : 2n;
const MAX_WATCHER_STALENESS_MS = process.env.SUBSCRIPTION_SWEEP_MAX_WATCHER_STALENESS_MS
  ? parseInt(process.env.SUBSCRIPTION_SWEEP_MAX_WATCHER_STALENESS_MS, 10)
  : 5 * 60 * 1000;
const DEADLINE_SECONDS = 600;

const ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function pnlPricePerPeriod() view returns (uint256)",
  "function MAX_PERIODS_PER_PURCHASE() view returns (uint256)",
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
    // Same guard as the scheduler: if the purchase-event watcher has stopped, its view of what's
    // owed for PnL can't be trusted, and sweeping on top of it risks paying out escrowed funds.
    const watcherState = await getPremiumSubscriptionWatcherState();
    const watcherAgeMs = watcherState?.updatedAt ? Date.now() - new Date(watcherState.updatedAt).getTime() : null;
    if (watcherAgeMs == null || watcherAgeMs > MAX_WATCHER_STALENESS_MS) {
      return res.status(409).json({
        error: watcherAgeMs == null
          ? "Purchase-event watcher has no recorded state yet — can't tell what's still owed to PnL requests, so no safe amount can be quoted."
          : `Purchase-event watcher state is ${Math.round(watcherAgeMs / 1000)}s old (max ${MAX_WATCHER_STALENESS_MS / 1000}s) — its view of what's owed can't be trusted right now. Try again shortly.`,
      });
    }

    const provider = createRpcProvider();
    const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);
    const [operator, balance, owedRaw, pnlPricePerPeriod, maxPeriodsPerPurchase] = await Promise.all([
      contract.operator(),
      provider.getBalance(PREMIUM_SUBSCRIPTION_ADDRESS),
      getTotalPnlEscrowOwed(),
      contract.pnlPricePerPeriod(),
      contract.MAX_PERIODS_PER_PURCHASE(),
    ]);
    const owed = BigInt(owedRaw);
    const safetyBuffer = pnlPricePerPeriod * maxPeriodsPerPurchase * SAFETY_BUFFER_MULTIPLIER;
    let amount = balance - owed - safetyBuffer;
    if (amount < 0n) amount = 0n;

    const minCoreOut = amount > 0n ? await quoteMinCoreOut(contract, provider, amount, SLIPPAGE_BPS) : 0n;

    // Everything as decimal strings — these are uint256s, never JSON numbers.
    res.json({
      contractAddress: PREMIUM_SUBSCRIPTION_ADDRESS,
      operator,
      balance: balance.toString(),
      owed: owed.toString(),
      safetyBuffer: safetyBuffer.toString(),
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
