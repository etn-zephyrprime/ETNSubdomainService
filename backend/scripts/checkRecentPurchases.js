// backend/scripts/checkRecentPurchases.js
//
// Read-only — scans recent blocks on PremiumSubscription (PlanetZephyrosPnLStatement) for
// MembershipPurchased / AnnualMembershipPurchased / PnlPeriodPurchased events (same three the
// purchase-event watcher itself tracks — see premiumSubscriptionWatcher.js), and prints each one
// found with its block timestamp.
//
// Built to answer one specific question before a MANUAL executeSplitForPeriod call: is a purchase
// plausibly "in flight" right now (paid on-chain but not yet reflected as "owed" anywhere), which
// is exactly the race subscriptionRevenueSweepScheduler.js's safety buffer exists to guard against
// (see that file's own header comment) but that formula can be wildly conservative relative to a
// small current balance -- see quoteSplitValues.js/checkSplitConfig.js. This doesn't replace that
// safety math; it's evidence for a human operator's OWN informed judgment call about a smaller,
// deliberately-chosen margin for one specific manual sweep -- not a substitute for it.
//
// Scans backward from the latest block in bounded chunks (this chain's RPC appears to cap
// getLogs' block range, same as coreClashSwapWatcher.js's own MAX_BLOCK_RANGE) up to LOOKBACK_BLOCKS
// total, or until it's found and printed every purchase event in that window -- whichever comes
// first isn't a thing here, it always scans the full window so "nothing found" is a real negative,
// not just "stopped looking after the first hit."
//
// Usage: node backend/scripts/checkRecentPurchases.js [lookbackBlocks]
//   (default lookback: 20000 blocks)
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";

dotenv.config();

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const CHUNK_SIZE = 500; // same cap coreClashSwapWatcher.js's own MAX_BLOCK_RANGE uses on this chain's RPC
const LOOKBACK_BLOCKS = parseInt(process.argv[2] || "20000", 10);

const ABI = [
  "event MembershipPurchased(address indexed subscriber, uint256 numMonths, uint256 paid, uint256 newExpiry)",
  "event AnnualMembershipPurchased(address indexed subscriber, uint256 numYears, uint256 paid, uint256 newExpiry)",
  "event PnlPeriodPurchased(address indexed payer, address indexed trackedWallet, uint8 periodType, uint16 year, uint64 periodEnd, uint256 amountPaid)",
];

async function main() {
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    throw new Error("PREMIUM_SUBSCRIPTION_ADDRESS not set — can't check the live contract.");
  }

  const provider = createRpcProvider();
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, ABI, provider);
  const iface = contract.interface;

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS);
  console.log(`Scanning blocks ${fromBlock} → ${latestBlock} (${LOOKBACK_BLOCKS} blocks back) for purchase events...\n`);

  const topics = [
    [
      iface.getEvent("MembershipPurchased").topicHash,
      iface.getEvent("AnnualMembershipPurchased").topicHash,
      iface.getEvent("PnlPeriodPurchased").topicHash,
    ],
  ];

  const found = [];
  for (let start = fromBlock; start <= latestBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, latestBlock);
    const logs = await provider.getLogs({ address: PREMIUM_SUBSCRIPTION_ADDRESS, fromBlock: start, toBlock: end, topics });
    for (const log of logs) {
      try {
        const parsed = iface.parseLog(log);
        found.push({ name: parsed.name, args: parsed.args, blockNumber: log.blockNumber, txHash: log.transactionHash });
      } catch {
        // ignore unrelated/unparseable logs
      }
    }
  }

  if (found.length === 0) {
    console.log(`✅ No purchase events found in the last ${LOOKBACK_BLOCKS} blocks.`);
    return;
  }

  console.log(`Found ${found.length} purchase event(s), most recent last:\n`);
  // Fetch each event's block timestamp so recency is in real time, not just block numbers.
  for (const ev of found.sort((a, b) => a.blockNumber - b.blockNumber)) {
    const block = await provider.getBlock(ev.blockNumber);
    const when = new Date(block.timestamp * 1000).toISOString();
    const paid = ev.args.paid ?? ev.args.amountPaid;
    console.log(`  ${when}  ${ev.name}  ${ethers.formatEther(paid)} ETN  (block ${ev.blockNumber}, tx ${ev.txHash})`);
  }
  const mostRecent = found[found.length - 1];
  const mostRecentBlock = await provider.getBlock(mostRecent.blockNumber);
  const minutesAgo = Math.round((Date.now() / 1000 - mostRecentBlock.timestamp) / 60);
  console.log(`\nMost recent purchase: ${minutesAgo} minute(s) ago.`);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
