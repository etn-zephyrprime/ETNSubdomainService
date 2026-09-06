// backend/utils/premiumSplitQuote.js
//
// Shared minCoreOut slippage math for calling PlanetZephyrosPnLStatement.executeSplitForPeriod —
// originally lived only in pnlSplitExecutionScheduler.js (itself copied from the PlanetZephyros
// repo's own scripts/autoBuyBackAndBurn.js), extracted here once subscriptionRevenueSweepScheduler.js
// needed the exact same quote. Deliberately shared (unlike this backend's watchers, which are each
// "fine to drift independently" by design) — this is real financial math computing how much
// slippage to accept before real ETN gets swapped, and the two callers should never be able to
// silently diverge on it.
import { ethers } from "ethers";

const ROUTER_ABI = [
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];

/** Quotes minCoreOut for splitting `amount` via executeSplitForPeriod — that function swaps only
 * half of `amount` (see PremiumSubscription.sol), so this quotes against that same half, not the
 * full amount. `slippageBps` defaults to 500 (5%), matching autoBuyBackAndBurn.js's own covers-
 * CORE's-fee-on-transfer-tax-plus-ordinary-movement reasoning — pass a wider value for a call
 * expected to sit in the mempool longer, or right after a large trade is known to have moved the
 * pool. */
export async function quoteMinCoreOut(contract, provider, amount, slippageBps = 500n) {
  const [coreToken, routerAddress] = await Promise.all([contract.coreToken(), contract.swapRouter()]);
  if (coreToken === ethers.ZeroAddress || routerAddress === ethers.ZeroAddress) {
    throw new Error("coreToken/swapRouter not configured on PremiumSubscription — cannot quote");
  }

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const weth = await router.WETH();
  const toSwap = amount - amount / 2n;
  const amounts = await router.getAmountsOut(toSwap, [weth, coreToken]);
  const quotedOut = amounts[1];
  return (quotedOut * (10000n - slippageBps)) / 10000n;
}
