// backend/utils/subscriptionRevenueSweepScheduler.js
//
// Sweeps membership subscription revenue (subscribe()/subscribeAnnual()) through
// PlanetZephyrosPnLStatement's existing executeSplitForPeriod — the contract itself doesn't
// distinguish "why" a released amount was owed, it just splits whatever the operator names. That
// contract's subscribe()/subscribeAnnual() collect payment but never call any split logic at all
// (confirmed live: a real subscription's ETN just sits in the contract's balance forever, with no
// withdraw path except this same function) — this scheduler is what actually recovers it, on a
// timer, since the contract itself was never going to.
//
// The one real risk this whole file exists to avoid: sweeping ETN that's actually still owed to a
// PnL statement request (a refund that hasn't happened yet, or a FINALIZED request whose split
// hasn't run yet — see pnlSplitExecutionScheduler.js, which owns that queue and must remain the
// ONLY thing that ever sweeps PnL money). The sweepable amount is always computed fresh each tick
// by premiumSplitQuote.js's computeSafeSplitAmount — (live contract balance) - (everything still
// owed for PnL: the database's own total plus any PnlPeriodPurchased events on-chain the purchase
// watcher hasn't recorded yet) - (a small margin) — never as an accumulated "how much subscription
// revenue has arrived since last time" counter, so correctness is a property of one subtraction
// each tick, not of bookkeeping that could drift. (This used to subtract a fixed worst-case-
// purchase buffer instead — 360,000 ETN at 15,000 ETN/period — which exceeded any real balance and
// meant the sweep never fired; see computeSafeSplitAmount's own comment.)
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { insertSubscriptionRevenueSweep } from "../db/subscriptionRevenueSweeps.js";
import { quoteMinCoreOut, computeSafeSplitAmount } from "./premiumSplitQuote.js";

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
// Subscription revenue has no refund deadline or customer waiting on it the way PnL escrow does —
// this can run far less often than pnlSplitExecutionScheduler.js's 5-minute check. Real ETN sitting
// idle is still worth recovering promptly, so this isn't lazy either.
const CHECK_INTERVAL_MS = process.env.SUBSCRIPTION_SWEEP_CHECK_INTERVAL_MS
  ? parseInt(process.env.SUBSCRIPTION_SWEEP_CHECK_INTERVAL_MS, 10)
  : 30 * 60 * 1000;
// Below this, skip — not worth the gas for a dust sweep. In ETN (parsed with parseEther below),
// not wei, for readability.
const MIN_SWEEP_ETN = process.env.SUBSCRIPTION_SWEEP_MIN_ETN || "100";
// Small fixed margin left in the contract on every sweep (in ETN, parsed below). The real
// protection against sweeping escrowed PnL money is computeSafeSplitAmount's exact accounting, not
// this — it only absorbs rounding-level surprises.
const SAFETY_MARGIN_ETN = process.env.SUBSCRIPTION_SWEEP_SAFETY_MARGIN_ETN || "10";
const SLIPPAGE_BPS = BigInt(process.env.SUBSCRIPTION_SWEEP_SLIPPAGE_BPS || "500");
const SWEEP_GAS_LIMIT = process.env.SUBSCRIPTION_SWEEP_GAS_LIMIT ? parseInt(process.env.SUBSCRIPTION_SWEEP_GAS_LIMIT, 10) : 500000;

const PREMIUM_SUBSCRIPTION_ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function executeSplitForPeriod(uint256 amount, uint256 minCoreOut, uint256 deadline) external",
  "event PnlPeriodSplitExecuted(address indexed operator, uint256 amountSplit, address splitWallet, uint256 coreReceived, uint256 coreBurned)",
];

let isRunning = false;

async function checkAndSweep(ctx) {
  if (isRunning) return;
  isRunning = true;
  try {
    const { contract, contractWithSigner, provider, wallet } = ctx;

    const { balance, owed, unrecorded, amount: sweepable } = await computeSafeSplitAmount(provider, PREMIUM_SUBSCRIPTION_ADDRESS, {
      safetyMarginWei: ethers.parseEther(SAFETY_MARGIN_ETN),
    });

    const minSweepWei = ethers.parseEther(MIN_SWEEP_ETN);
    if (sweepable < minSweepWei) {
      console.log(`⏭️  Subscription revenue sweep: ${ethers.formatEther(sweepable)} ETN sweepable (balance ${ethers.formatEther(balance)}, owed ${ethers.formatEther(owed)}${unrecorded > 0n ? `, of which ${ethers.formatEther(unrecorded)} not yet recorded by the watcher` : ""}) — below ${MIN_SWEEP_ETN} ETN minimum, skipping`);
      return;
    }

    console.log(`🔥 Sweeping ${ethers.formatEther(sweepable)} ETN of subscription revenue (balance ${ethers.formatEther(balance)}, owed to PnL ${ethers.formatEther(owed)})`);

    const minCoreOut = await quoteMinCoreOut(contract, provider, sweepable, SLIPPAGE_BPS);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const tx = await contractWithSigner.executeSplitForPeriod(sweepable, minCoreOut, deadline, { gasLimit: SWEEP_GAS_LIMIT });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("executeSplitForPeriod transaction failed");

    const event = receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "PnlPeriodSplitExecuted");

    await insertSubscriptionRevenueSweep({
      amountSweptWei: sweepable,
      balanceAtSweepWei: balance,
      pnlOwedAtSweepWei: owed,
      blockNumber: receipt.blockNumber,
      swapAndBurnTxHash: tx.hash,
      coreReceived: event ? ethers.formatEther(event.args.coreReceived) : null,
      coreBurned: event ? ethers.formatEther(event.args.coreBurned) : null,
      operatorAddress: wallet.address,
    });

    console.log(`✅ Subscription revenue sweep executed (tx ${tx.hash})`);
  } catch (err) {
    console.error("⚠️  Subscription revenue sweep check failed:", err.message);
    if (err.data) console.error("   Raw data:", err.data);
    // No rethrow — recomputed fresh next tick from live balance/owed, nothing to roll back.
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background sweeper. No-ops cleanly (logs and returns) if BACKEND_PRIVATE_KEY,
 * PREMIUM_SUBSCRIPTION_ADDRESS, or DATABASE_URL isn't configured — same guard shape as
 * pnlSplitExecutionScheduler.js's startPnlSplitExecutionScheduler().
 */
export async function startSubscriptionRevenueSweepScheduler() {
  if (!process.env.BACKEND_PRIVATE_KEY) {
    console.log("ℹ️  BACKEND_PRIVATE_KEY not set — subscription revenue sweep scheduler disabled");
    return;
  }
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    console.log("ℹ️  PREMIUM_SUBSCRIPTION_ADDRESS not set — subscription revenue sweep scheduler disabled");
    return;
  }
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — subscription revenue sweep scheduler disabled");
    return;
  }

  const provider = createRpcProvider();
  const wallet = new ethers.Wallet(process.env.BACKEND_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PREMIUM_SUBSCRIPTION_ABI, provider);
  const contractWithSigner = contract.connect(wallet);

  console.log("🔥 Subscription revenue sweep scheduler initializing...");
  console.log("   Operator wallet:      ", wallet.address);
  console.log("   PremiumSubscription:  ", PREMIUM_SUBSCRIPTION_ADDRESS);

  try {
    const operator = await contract.operator();
    if (operator.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error("❌ CRITICAL: this wallet is NOT PremiumSubscription's operator — executeSplitForPeriod calls will revert");
    } else {
      console.log("✅ Operator verification passed");
    }
  } catch (err) {
    console.error("❌ Failed to read PremiumSubscription operator:", err.message);
  }

  const ctx = { contract, contractWithSigner, provider, wallet };
  console.log(`🔥 Subscription revenue sweep scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAndSweep(ctx);
  setInterval(() => checkAndSweep(ctx), CHECK_INTERVAL_MS);
}
