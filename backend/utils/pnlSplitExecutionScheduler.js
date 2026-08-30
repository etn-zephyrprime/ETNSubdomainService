// backend/utils/pnlSplitExecutionScheduler.js
//
// Executes PremiumSubscription.executeSplitForPeriod() for every statement request that just
// transitioned to FINALIZED (see PremiumSubscription.sol's header comment: this contract has no
// visibility into that state machine, and trusts the operator to call this with the right amount
// — that operator is this backend, via CORE_CLASH_BACKEND_PRIVATE_KEY). Modeled directly on
// coreClashDripBot.js's wallet-signing pattern: separate read-only `contract` vs write-capable
// `contractWithSigner`, a startup sanity check that logs CRITICAL but doesn't crash if this
// wallet isn't actually the contract's operator, per-tick try/catch with no rethrow, fixed
// gasLimit (this chain's eth_estimateGas is unreliable — see rpcProvider.js and every other write
// call in this backend). The minCoreOut slippage math is copied from the PlanetZephyros repo's
// own scripts/autoBuyBackAndBurn.js, which runs this same swap-and-burn shape for the
// marketplace's own fee pool.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getPool } from "../db/pool.js";
import { findFinalizedNeedingSplit } from "../db/statementRequests.js";
import { insertBuyAndBurnLog } from "../db/buyAndBurnLog.js";

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const CHECK_INTERVAL_MS = process.env.PNL_SPLIT_EXECUTION_CHECK_INTERVAL_MS
  ? parseInt(process.env.PNL_SPLIT_EXECUTION_CHECK_INTERVAL_MS, 10)
  : 5 * 60 * 1000; // real ETN sitting escrowed/CORE not yet burned — checked more often than the 14-day finalize job
// Same reasoning and same default as autoBuyBackAndBurn.js: covers CORE's own fee-on-transfer tax
// (~1.5%, decaying, as of that script's last check) plus ordinary price movement between quoting
// and the tx actually mining.
const SLIPPAGE_BPS = BigInt(process.env.PNL_SPLIT_SLIPPAGE_BPS || "500");
const SPLIT_GAS_LIMIT = process.env.PNL_SPLIT_GAS_LIMIT ? parseInt(process.env.PNL_SPLIT_GAS_LIMIT, 10) : 500000;

const PREMIUM_SUBSCRIPTION_ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function executeSplitForPeriod(uint256 amount, uint256 minCoreOut, uint256 deadline) external",
  "event PnlPeriodSplitExecuted(address indexed operator, uint256 amountSplit, address splitWallet, uint256 coreReceived, uint256 coreBurned)",
];
const ROUTER_ABI = [
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];

async function quoteMinCoreOut(contract, provider, amount) {
  const [coreToken, routerAddress] = await Promise.all([contract.coreToken(), contract.swapRouter()]);
  if (coreToken === ethers.ZeroAddress || routerAddress === ethers.ZeroAddress) {
    throw new Error("coreToken/swapRouter not configured on PremiumSubscription — cannot quote");
  }

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const weth = await router.WETH();
  // executeSplitForPeriod swaps only half of `amount` (see PremiumSubscription.sol) — quote
  // against that same half, not the full escrowed amount.
  const toSwap = amount - amount / 2n;
  const amounts = await router.getAmountsOut(toSwap, [weth, coreToken]);
  const quotedOut = amounts[1];
  return (quotedOut * (10000n - SLIPPAGE_BPS)) / 10000n;
}

let isRunning = false;

async function checkAndExecute(ctx) {
  if (isRunning) return;
  isRunning = true;
  try {
    const { contract, contractWithSigner, provider, wallet } = ctx;
    const pending = await findFinalizedNeedingSplit();

    for (const request of pending) {
      try {
        const amount = BigInt(request.amount_paid_wei);
        const minCoreOut = await quoteMinCoreOut(contract, provider, amount);
        const deadline = Math.floor(Date.now() / 1000) + 600;

        console.log(`🔥 Executing split for statement request ${request.id} — ${ethers.formatEther(amount)} ETN`);
        const tx = await contractWithSigner.executeSplitForPeriod(amount, minCoreOut, deadline, { gasLimit: SPLIT_GAS_LIMIT });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("executeSplitForPeriod transaction failed");

        const event = receipt.logs
          .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "PnlPeriodSplitExecuted");

        await insertBuyAndBurnLog({
          statementRequestId: request.id,
          splitWalletAmountWei: amount / 2n, // matches PremiumSubscription.sol's own toSplitWallet = amount / 2
          swapAndBurnTxHash: tx.hash,
          ethSwappedWei: amount - amount / 2n,
          coreReceived: event ? ethers.formatEther(event.args.coreReceived) : null,
          coreBurned: event ? ethers.formatEther(event.args.coreBurned) : null,
          operatorAddress: wallet.address,
        });

        console.log(`✅ Split executed for statement request ${request.id} (tx ${tx.hash})`);
      } catch (err) {
        console.error(`❌ Failed to execute split for statement request ${request.id}:`, err.message);
        if (err.data) console.error("   Raw data:", err.data);
        // No rethrow — one bad request must not block the rest of the queue, and gets retried
        // next tick (findFinalizedNeedingSplit() naturally re-selects it: no buy_and_burn_log row
        // was written).
      }
    }
  } catch (err) {
    console.error("⚠️  PnL split execution check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background executor. No-ops cleanly (logs and returns) if
 * CORE_CLASH_BACKEND_PRIVATE_KEY, PREMIUM_SUBSCRIPTION_ADDRESS, or DATABASE_URL isn't configured
 * — same guard shape as startCoreClashDripBot().
 */
export async function startPnlSplitExecutionScheduler() {
  if (!process.env.CORE_CLASH_BACKEND_PRIVATE_KEY) {
    console.log("ℹ️  CORE_CLASH_BACKEND_PRIVATE_KEY not set — PnL split execution scheduler disabled");
    return;
  }
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    console.log("ℹ️  PREMIUM_SUBSCRIPTION_ADDRESS not set — PnL split execution scheduler disabled");
    return;
  }
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — PnL split execution scheduler disabled");
    return;
  }

  const provider = createRpcProvider();
  const wallet = new ethers.Wallet(process.env.CORE_CLASH_BACKEND_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PREMIUM_SUBSCRIPTION_ABI, provider);
  const contractWithSigner = contract.connect(wallet);

  console.log("🔥 PnL split execution scheduler initializing...");
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
  console.log(`🔥 PnL split execution scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAndExecute(ctx);
  setInterval(() => checkAndExecute(ctx), CHECK_INTERVAL_MS);
}
