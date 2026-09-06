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
// as (current contract balance) - (everything the backend's own database still owes for PnL, see
// statementRequests.getTotalPnlEscrowOwed) - (a safety buffer) — never as an accumulated "how much
// subscription revenue has arrived since last time" counter. That framing makes correctness a
// property of one subtraction each tick, not of bookkeeping that could drift over time.
//
// Why balance is read at "latest", not at some earlier consistent snapshot block: an earlier draft
// of this scheduler tried reading the contract's balance as of premiumSubscriptionWatcher.js's own
// lastProcessedBlock cursor, reasoning that would guarantee "balance" and "owed" describe the same
// moment. That's backwards for the refund/split side of the ledger: a refund or an executed PnL
// split happens synchronously with its own DB update (the /refund route calls markRefunded right
// after the tx confirms; pnlSplitExecutionScheduler.js calls insertBuyAndBurnLog right after its
// own tx confirms) — neither is gated by the purchase-event watcher's cursor at all. Reading a
// STALE balance snapshot from before such a refund/split, alongside a CURRENT "owed" query that
// (correctly) already excludes that now-resolved request, overstates sweepable by exactly that
// refunded/split amount. Live balance has no such gap. The only real race is the other direction —
// a brand-new PnL purchase landing on-chain before the purchase-event watcher has recorded it in
// the database — and that's bounded and guarded against directly below (freshness gate + buffer),
// not by picking a different block to read balance at.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getTotalPnlEscrowOwed } from "../db/statementRequests.js";
import { insertSubscriptionRevenueSweep } from "../db/subscriptionRevenueSweeps.js";
import { getPremiumSubscriptionWatcherState } from "../state/premiumSubscriptionWatcherState.js";
import { quoteMinCoreOut } from "./premiumSplitQuote.js";

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
// Subscription revenue has no refund deadline or customer waiting on it the way PnL escrow does —
// this can run far less often than pnlSplitExecutionScheduler.js's 5-minute check. Real ETN sitting
// idle is still worth recovering promptly, so this isn't lazy either.
const CHECK_INTERVAL_MS = process.env.SUBSCRIPTION_SWEEP_CHECK_INTERVAL_MS
  ? parseInt(process.env.SUBSCRIPTION_SWEEP_CHECK_INTERVAL_MS, 10)
  : 30 * 60 * 1000;
// If the purchase-event watcher's own state hasn't been updated within this window, its view of
// "what's owed for PnL" can't be trusted to include recent purchases — skip the tick entirely
// rather than risk sweeping a just-arrived PnL payment it hasn't recorded yet. Comfortably above
// that watcher's own 60s default poll interval, to tolerate an occasional slow tick without
// treating it as an outage.
const MAX_WATCHER_STALENESS_MS = process.env.SUBSCRIPTION_SWEEP_MAX_WATCHER_STALENESS_MS
  ? parseInt(process.env.SUBSCRIPTION_SWEEP_MAX_WATCHER_STALENESS_MS, 10)
  : 5 * 60 * 1000;
// Below this, skip — not worth the gas for a dust sweep. In ETN (parsed with parseEther below),
// not wei, for readability.
const MIN_SWEEP_ETN = process.env.SUBSCRIPTION_SWEEP_MIN_ETN || "100";
// Multiplies the dynamic single-purchase-sized floor (MAX_PERIODS_PER_PURCHASE *
// pnlPricePerPeriod, read live from the contract — never hardcoded, so an owner price change can
// never quietly shrink this below what it needs to cover) for extra headroom against more than one
// unrecorded purchase landing inside the freshness window above. 1 alone already covers the
// worst-case SINGLE purchase; 2 is deliberate slack, not a guess.
const SAFETY_BUFFER_MULTIPLIER = process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER
  ? BigInt(process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER)
  : 2n;
const SLIPPAGE_BPS = BigInt(process.env.SUBSCRIPTION_SWEEP_SLIPPAGE_BPS || "500");
const SWEEP_GAS_LIMIT = process.env.SUBSCRIPTION_SWEEP_GAS_LIMIT ? parseInt(process.env.SUBSCRIPTION_SWEEP_GAS_LIMIT, 10) : 500000;

const PREMIUM_SUBSCRIPTION_ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function pnlPricePerPeriod() view returns (uint256)",
  "function MAX_PERIODS_PER_PURCHASE() view returns (uint256)",
  "function executeSplitForPeriod(uint256 amount, uint256 minCoreOut, uint256 deadline) external",
  "event PnlPeriodSplitExecuted(address indexed operator, uint256 amountSplit, address splitWallet, uint256 coreReceived, uint256 coreBurned)",
];

let isRunning = false;

async function checkAndSweep(ctx) {
  if (isRunning) return;
  isRunning = true;
  try {
    const { contract, contractWithSigner, provider, wallet } = ctx;

    const watcherState = await getPremiumSubscriptionWatcherState();
    if (!watcherState?.updatedAt) {
      console.log("⏭️  Subscription revenue sweep skipped — purchase-event watcher has no recorded state yet");
      return;
    }
    const watcherAgeMs = Date.now() - new Date(watcherState.updatedAt).getTime();
    if (watcherAgeMs > MAX_WATCHER_STALENESS_MS) {
      console.warn(`⏭️  Subscription revenue sweep skipped — purchase-event watcher state is ${Math.round(watcherAgeMs / 1000)}s old (max ${MAX_WATCHER_STALENESS_MS / 1000}s): its view of what's owed for PnL can't be trusted right now`);
      return;
    }

    const [balance, owedRaw, pnlPricePerPeriod, maxPeriodsPerPurchase] = await Promise.all([
      provider.getBalance(PREMIUM_SUBSCRIPTION_ADDRESS),
      getTotalPnlEscrowOwed(),
      contract.pnlPricePerPeriod(),
      contract.MAX_PERIODS_PER_PURCHASE(),
    ]);
    const owed = BigInt(owedRaw);

    // Worst case a single purchasePnlPeriods call could ever charge, read live so an owner price
    // change is reflected automatically — see the constant's own comment above for why this (times
    // SAFETY_BUFFER_MULTIPLIER) is the buffer, not an arbitrary round number.
    const safetyBuffer = pnlPricePerPeriod * maxPeriodsPerPurchase * SAFETY_BUFFER_MULTIPLIER;

    let sweepable = balance - owed - safetyBuffer;
    if (sweepable < 0n) sweepable = 0n;

    const minSweepWei = ethers.parseEther(MIN_SWEEP_ETN);
    if (sweepable < minSweepWei) {
      console.log(`⏭️  Subscription revenue sweep: ${ethers.formatEther(sweepable)} ETN sweepable (balance ${ethers.formatEther(balance)}, owed ${ethers.formatEther(owed)}, buffer ${ethers.formatEther(safetyBuffer)}) — below ${MIN_SWEEP_ETN} ETN minimum, skipping`);
      return;
    }

    console.log(`🔥 Sweeping ${ethers.formatEther(sweepable)} ETN of subscription revenue (balance ${ethers.formatEther(balance)}, owed to PnL ${ethers.formatEther(owed)}, buffer ${ethers.formatEther(safetyBuffer)})`);

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
