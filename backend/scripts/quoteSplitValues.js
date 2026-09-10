// backend/scripts/quoteSplitValues.js
//
// Read-only — computes the (amount, minCoreOut, deadline) values for a MANUAL
// executeSplitForPeriod call, using the exact same safe-sweep formula
// subscriptionRevenueSweepScheduler.js uses automatically: amount = (contract balance) - (ETN
// still owed to PnL statement escrow) - (a safety buffer covering the worst-case single PnL
// purchase, doubled). This is the number that's SAFE to split without accidentally sweeping money
// that's actually still owed to a pending/refundable PnL statement request — do not just pass the
// contract's raw balance.
//
// Prints the values and stops there. Does NOT execute anything, needs no private key. Submit the
// printed values yourself (Blockscout's Write Contract tab, Remix, your own script, etc.) as the
// wallet that's actually the contract's operator() (see diagnoseSplitExecution.js to check that).
//
// deadline is only valid for 10 minutes from when this prints — if more time than that passes
// before you actually submit the transaction, re-run this script rather than reusing a stale value
// (the tx will simply revert past its deadline, no funds at risk either way).
//
// Usage: node backend/scripts/quoteSplitValues.js
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getTotalPnlEscrowOwed } from "../db/statementRequests.js";
import { quoteMinCoreOut } from "../utils/premiumSplitQuote.js";

dotenv.config();

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const SLIPPAGE_BPS = BigInt(process.env.PNL_SPLIT_SLIPPAGE_BPS || "500");
// Same default/reasoning as subscriptionRevenueSweepScheduler.js's own SAFETY_BUFFER_MULTIPLIER.
const SAFETY_BUFFER_MULTIPLIER = process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER
  ? BigInt(process.env.SUBSCRIPTION_SWEEP_SAFETY_MULTIPLIER)
  : 2n;

const ABI = [
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function pnlPricePerPeriod() view returns (uint256)",
  "function MAX_PERIODS_PER_PURCHASE() view returns (uint256)",
];

async function main() {
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    throw new Error("PREMIUM_SUBSCRIPTION_ADDRESS not set — can't check the live contract.");
  }
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — can't compute how much is still owed to PnL escrow (needed to know a SAFE amount).");
  }

  const provider = createRpcProvider();
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);

  const [balance, owedRaw, pnlPricePerPeriod, maxPeriodsPerPurchase] = await Promise.all([
    provider.getBalance(PREMIUM_SUBSCRIPTION_ADDRESS),
    getTotalPnlEscrowOwed(),
    contract.pnlPricePerPeriod(),
    contract.MAX_PERIODS_PER_PURCHASE(),
  ]);
  const owed = BigInt(owedRaw);
  const safetyBuffer = pnlPricePerPeriod * maxPeriodsPerPurchase * SAFETY_BUFFER_MULTIPLIER;

  let amount = balance - owed - safetyBuffer;
  if (amount < 0n) amount = 0n;

  console.log("Contract:      ", PREMIUM_SUBSCRIPTION_ADDRESS);
  console.log("Live balance:  ", ethers.formatEther(balance), "ETN");
  console.log("Owed to PnL:   ", ethers.formatEther(owed), "ETN");
  console.log("Safety buffer: ", ethers.formatEther(safetyBuffer), "ETN  (worst-case single PnL purchase × 2)");
  console.log("─────────────────────────────────────────────");
  console.log("SAFE amount:   ", ethers.formatEther(amount), "ETN", amount === 0n ? "  ⚠️  nothing safe to split right now" : "");

  if (amount === 0n) {
    if (getPool()) await getPool().end();
    return;
  }

  const minCoreOut = await quoteMinCoreOut(contract, provider, amount, SLIPPAGE_BPS);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  console.log("\nexecuteSplitForPeriod arguments:");
  console.log("  amount     =", amount.toString(), `(wei — ${ethers.formatEther(amount)} ETN)`);
  console.log("  minCoreOut =", minCoreOut.toString(), "(wei CORE, 5% slippage on the live quote)");
  console.log("  deadline   =", deadline, `(unix seconds — expires ${new Date(deadline * 1000).toISOString()}, ~10 min from now)`);

  if (getPool()) await getPool().end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
