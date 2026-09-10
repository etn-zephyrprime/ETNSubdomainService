// backend/scripts/quoteSplitValuesManual.js
//
// Read-only — like quoteSplitValues.js, but for an EXPLICIT amount you choose (in ETN) instead of
// the full formulaic safety buffer (worst-case single purchase × safety multiplier — see that
// script's own comment, and checkSplitConfig.js for why that buffer can be enormous relative to a
// small balance). Meant to be used after checkRecentPurchases.js shows nothing recently purchased
// (no purchase plausibly still "in flight" and unrecorded) — that's the informed judgment call this
// script deliberately leaves to you rather than making automatically.
//
// The ONE hard floor this still enforces, unconditionally: amount can never exceed (contract
// balance - ETN still owed to PnL statement escrow). That's not a tunable safety margin, it's
// "don't sweep money a pending/refundable PnL statement request actually needs" — the one thing
// this script refuses to let you override, no matter how confident you are.
//
// Usage: node backend/scripts/quoteSplitValuesManual.js <amountEtn>
//   e.g.: node backend/scripts/quoteSplitValuesManual.js 3000
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getTotalPnlEscrowOwed } from "../db/statementRequests.js";
import { quoteMinCoreOut } from "../utils/premiumSplitQuote.js";

dotenv.config();

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const SLIPPAGE_BPS = BigInt(process.env.PNL_SPLIT_SLIPPAGE_BPS || "500");
const requestedEtn = process.argv[2];

const ABI = [
  "function coreToken() view returns (address)",
  "function swapRouter() view returns (address)",
];

async function main() {
  if (!requestedEtn || !/^\d+(\.\d+)?$/.test(requestedEtn)) {
    throw new Error("Usage: node backend/scripts/quoteSplitValuesManual.js <amountEtn>  (e.g. 3000)");
  }
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    throw new Error("PREMIUM_SUBSCRIPTION_ADDRESS not set — can't check the live contract.");
  }
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — can't compute how much is still owed to PnL escrow.");
  }

  const provider = createRpcProvider();
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);

  const [balance, owedRaw] = await Promise.all([
    provider.getBalance(PREMIUM_SUBSCRIPTION_ADDRESS),
    getTotalPnlEscrowOwed(),
  ]);
  const owed = BigInt(owedRaw);
  const maxSafe = balance - owed; // the one hard, non-negotiable floor — see this file's own header comment

  const amount = ethers.parseEther(requestedEtn);

  console.log("Contract:     ", PREMIUM_SUBSCRIPTION_ADDRESS);
  console.log("Live balance: ", ethers.formatEther(balance), "ETN");
  console.log("Owed to PnL:  ", ethers.formatEther(owed), "ETN");
  console.log("Max allowed:  ", ethers.formatEther(maxSafe), "ETN  (balance - owed — hard floor, never overridden)");
  console.log("Requested:    ", ethers.formatEther(amount), "ETN");
  console.log("─────────────────────────────────────────────");

  if (amount > maxSafe) {
    console.log(`❌ Requested amount exceeds the hard floor (balance - owed). Refusing — max you can safely request right now is ${ethers.formatEther(maxSafe)} ETN.`);
    if (getPool()) await getPool().end();
    process.exitCode = 1;
    return;
  }

  const minCoreOut = await quoteMinCoreOut(contract, provider, amount, SLIPPAGE_BPS);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  console.log("✅ Within the hard floor.\n");
  console.log("executeSplitForPeriod arguments:");
  console.log("  amount     =", amount.toString(), `(wei — ${ethers.formatEther(amount)} ETN)`);
  console.log("  minCoreOut =", minCoreOut.toString(), "(wei CORE, 5% slippage on the live quote)");
  console.log("  deadline   =", deadline, `(unix seconds — expires ${new Date(deadline * 1000).toISOString()}, ~10 min from now)`);

  if (getPool()) await getPool().end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
