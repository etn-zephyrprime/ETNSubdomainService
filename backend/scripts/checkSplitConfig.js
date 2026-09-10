// backend/scripts/checkSplitConfig.js
//
// Read-only — prints the raw on-chain values that drive executeSplitForPeriod's safety buffer
// (pnlPricePerPeriod, MAX_PERIODS_PER_PURCHASE — see quoteSplitValues.js), so an unexpectedly huge
// buffer can be traced back to whichever of the two is actually large, rather than guessed at.
//
// Usage: node backend/scripts/checkSplitConfig.js
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";

dotenv.config();

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const ABI = [
  "function pnlPricePerPeriod() view returns (uint256)",
  "function MAX_PERIODS_PER_PURCHASE() view returns (uint256)",
];

async function main() {
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    throw new Error("PREMIUM_SUBSCRIPTION_ADDRESS not set — can't check the live contract.");
  }

  const provider = createRpcProvider();
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);

  const [pnlPricePerPeriod, maxPeriodsPerPurchase] = await Promise.all([
    contract.pnlPricePerPeriod(),
    contract.MAX_PERIODS_PER_PURCHASE(),
  ]);

  console.log("pnlPricePerPeriod (raw wei):      ", pnlPricePerPeriod.toString());
  console.log("pnlPricePerPeriod (as ETN):        ", ethers.formatEther(pnlPricePerPeriod));
  console.log("MAX_PERIODS_PER_PURCHASE (raw):    ", maxPeriodsPerPurchase.toString());
  console.log("─────────────────────────────────────────────");
  console.log("Implied worst-case single purchase:", ethers.formatEther(pnlPricePerPeriod * maxPeriodsPerPurchase), "ETN");
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
