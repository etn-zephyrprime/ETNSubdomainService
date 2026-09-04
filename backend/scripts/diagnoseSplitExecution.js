// backend/scripts/diagnoseSplitExecution.js
//
// A FINALIZED statement request's fee split (PremiumSubscription.executeSplitForPeriod, run by
// pnlSplitExecutionScheduler.js on a 5-minute poll) can fail to happen for several unrelated
// reasons. Rather than guessing, this checks all of them against the live contract and DB in one
// pass:
//   - is anything actually FINALIZED and awaiting a split at all (findFinalizedNeedingSplit)?
//   - amount_paid_wei = 0 (free/member access) never splits by design -- not a bug
//   - operator() on-chain vs this env's BACKEND_PRIVATE_KEY -- a mismatch means
//     executeSplitForPeriod reverts every single time, silently (the scheduler logs and moves on,
//     no rethrow)
//   - coreToken/swapRouter wired up at all -- same "never wired after deploy" class of gap as the
//     erevosShares issue
//   - a live swap quote through that router -- catches a bad/no-liquidity pair even if the
//     addresses themselves are set
//
// Read-only. Doesn't execute anything -- just tells you which of the above is the actual blocker.
//
// Usage: node scripts/diagnoseSplitExecution.js
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { findFinalizedNeedingSplit } from "../db/statementRequests.js";

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const ABI = [
  "function operator() view returns (address)",
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
];
const ROUTER_ABI = [
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];

if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
  console.error("PREMIUM_SUBSCRIPTION_ADDRESS not set in this shell — can't check the live contract.");
  process.exit(1);
}

const provider = createRpcProvider();
const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);

const pending = await findFinalizedNeedingSplit();
console.log(`${pending.length} FINALIZED request(s) awaiting a split.\n`);

if (pending.length === 0) {
  console.log("Nothing pending. Either it already split successfully (check the buy_and_burn_log table)");
  console.log("or the statement hasn't actually reached FINALIZED yet (still GENERATED — the /view beacon");
  console.log("may not have landed; check the request's own status/first_viewed_at).");
  process.exit(0);
}

for (const r of pending) {
  const free = BigInt(r.amount_paid_wei) === 0n;
  console.log(`  ${r.id}  amount_paid_wei=${r.amount_paid_wei}${free ? "  (free/member access — correctly never splits, not a bug)" : ""}`);
}

console.log("\nOn-chain config:");
const [operator, coreToken, swapRouter] = await Promise.all([
  contract.operator(),
  contract.coreToken(),
  contract.swapRouter(),
]);
console.log("  operator:  ", operator);
console.log("  coreToken: ", coreToken, coreToken === ethers.ZeroAddress ? "  ⚠️  UNSET — executeSplitForPeriod will revert" : "");
console.log("  swapRouter:", swapRouter, swapRouter === ethers.ZeroAddress ? "  ⚠️  UNSET — executeSplitForPeriod will revert" : "");

if (process.env.BACKEND_PRIVATE_KEY) {
  const wallet = new ethers.Wallet(process.env.BACKEND_PRIVATE_KEY, provider);
  const matches = wallet.address.toLowerCase() === operator.toLowerCase();
  console.log(`  BACKEND_PRIVATE_KEY address: ${wallet.address}`);
  console.log(`  matches operator?            ${matches ? "✅ yes" : "❌ NO — every executeSplitForPeriod call from this wallet will revert"}`);
} else {
  console.log("  BACKEND_PRIVATE_KEY not set in THIS shell — can't compare here, but the live server needs");
  console.log("  it set too (the scheduler no-ops entirely without it, silently, at boot).");
}

if (coreToken !== ethers.ZeroAddress && swapRouter !== ethers.ZeroAddress) {
  try {
    const router = new ethers.Contract(swapRouter, ROUTER_ABI, provider);
    const weth = await router.WETH();
    const testAmount = ethers.parseEther("1");
    const amounts = await router.getAmountsOut(testAmount, [weth, coreToken]);
    console.log(`\nSwap quote sanity check (1 ETN → CORE via swapRouter): OK — ${ethers.formatEther(amounts[1])} CORE`);
  } catch (err) {
    console.log(`\n⚠️  Swap quote failed: ${err.message}`);
    console.log("This is exactly what would silently block every real split attempt too.");
  }
}
