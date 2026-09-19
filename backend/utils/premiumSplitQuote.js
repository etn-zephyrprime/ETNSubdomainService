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
import { getTotalPnlEscrowOwed } from "../db/statementRequests.js";
import { getPremiumSubscriptionWatcherState } from "../state/premiumSubscriptionWatcherState.js";
import { queryLogsChunked } from "./premiumSubscriptionWatcher.js";

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

const PNL_PURCHASE_ABI = [
  "event PnlPeriodPurchased(address indexed payer, address indexed trackedWallet, uint8 periodType, uint16 year, uint64 periodEnd, uint256 amountPaid)",
];
// How far behind the purchase-event watcher's cursor may be before we refuse to quote rather than
// scan an unbounded block range (~1 block/5s on Electroneum, so this is roughly 11 days).
const MAX_UNRECORDED_SCAN_BLOCKS = 200000;

/** The amount of ETN that's SAFE to pass to executeSplitForPeriod right now: contract balance minus
 * everything still spoken for by PnL statement requests, minus a small margin. Shared by the
 * automatic sweep (subscriptionRevenueSweepScheduler.js), the admin button
 * (adminSplitRouter.js) and scripts/quoteSplitValues.js so they can never disagree.
 *
 * "Spoken for" = the database's own owed total (getTotalPnlEscrowOwed) PLUS any PnlPeriodPurchased
 * events the purchase-event watcher hasn't recorded yet, read straight off the chain. This
 * replaced a fixed buffer of (worst-case single purchase = MAX_PERIODS_PER_PURCHASE x
 * pnlPricePerPeriod) x 2 — 360,000 ETN at today's prices — whose only job was to cover exactly that
 * unrecorded-purchase gap, and which dwarfed every real balance so the sweep never fired. Counting
 * the gap directly makes the protection exact instead of a guess.
 *
 * Ordering matters and is deliberately conservative: watcher cursor first, THEN the database owed
 * total, THEN the on-chain scan from that cursor — a purchase the watcher records in between is
 * counted twice (smaller sweep), never zero times. Balance is read at the same block the scan ends
 * on. A purchase mined AFTER that block only adds to the balance, so it can't make the resulting
 * amount unsafe. Throws (rather than guess) when there's no cursor to scan from or it's too far
 * behind. */
export async function computeSafeSplitAmount(provider, contractAddress, { safetyMarginWei = 0n } = {}) {
  const state = await getPremiumSubscriptionWatcherState();
  const cursor = state?.lastProcessedBlock;
  if (!Number.isFinite(cursor)) {
    throw new Error("Purchase-event watcher has no recorded position yet — can't tell which PnL purchases are still unrecorded, so no safe amount can be computed.");
  }
  const owedDb = BigInt(await getTotalPnlEscrowOwed());

  const latestBlock = await provider.getBlockNumber();
  if (latestBlock - cursor > MAX_UNRECORDED_SCAN_BLOCKS) {
    throw new Error(`Purchase-event watcher is ${latestBlock - cursor} blocks behind (max ${MAX_UNRECORDED_SCAN_BLOCKS}) — refusing to quote until it catches up.`);
  }

  const contract = new ethers.Contract(contractAddress, PNL_PURCHASE_ABI, provider);
  const [balance, purchases] = await Promise.all([
    provider.getBalance(contractAddress, latestBlock),
    latestBlock > cursor ? queryLogsChunked(contract, contract.filters.PnlPeriodPurchased(), cursor + 1, latestBlock) : [],
  ]);
  const unrecorded = purchases.reduce((sum, e) => sum + e.args.amountPaid, 0n);

  const owed = owedDb + unrecorded;
  let amount = balance - owed - safetyMarginWei;
  if (amount < 0n) amount = 0n;
  return { latestBlock, watcherCursor: cursor, balance, owedDb, unrecorded, owed, safetyMarginWei, amount };
}
