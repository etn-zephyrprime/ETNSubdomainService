// backend/services/coreTaxScheduleService.js
//
// CORE's buy/sell tax is a fixed step function of its own circulating supply (a schedule the
// contract enforces internally — see the table below), never something the contract exposes as
// "tax rate at block N." To plot real tax-over-time on the Tokens tab's CORE burn chart, this
// binary-searches CORE's own totalSupply() at past blocks to find the EXACT block/date each
// threshold was first crossed — reading the contract's real historical state, not derived from
// this app's own burn-event log (which — since #360 — combines real burn() calls (zero address,
// the ONLY thing that actually reduces totalSupply()) with CORE also sent to the conventional dead
// address, which does NOT reduce totalSupply() and therefore does NOT move the contract's own tax
// tier). Using the burn-event log here would risk reporting a tax change too early.
//
// Requires an ARCHIVE node (createArchiveRpcProvider, not the failover pair — same reasoning as
// etnBridge.js's own historical-state reads: the public secondary node returns "missing revert
// data" for old state).
//
// Incremental and append-only: once a threshold's crossing block is found, it's never
// recomputed (totalSupply only decreases — burn-only, no mint — so a past crossing is a permanent
// historical fact). Each run only searches for thresholds CORE's CURRENT supply has newly reached
// since the last run, which is rare (this schedule empties out over months/years of burning, not
// days) — so this is deliberately a manual/low-frequency job, not a tight polling loop.
import { ethers } from "ethers";
import { createArchiveRpcProvider } from "../utils/rpcProvider.js";
import { fetchBlockscoutJson } from "../utils/blockscoutClient.js";
import { CORE_TOKEN_ADDRESS } from "../utils/coreClashConfig.js";
import { getCoreTaxScheduleCache, setCoreTaxScheduleCache } from "../state/coreTaxScheduleState.js";

const ERC20_ABI = ["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"];

// CORE's own published tax schedule — supply% -> {totalSupply (whole CORE), buyTaxPct, sellTaxPct}.
// Sell tax floors at 2% (200 bps) once supply drops to/below 50% (500,000 CORE) and stays there
// forever after — there's no threshold below 50 in the schedule because there's nothing further to
// step down to. NOTE per the schedule's own source: 80% of all tax collected is burned, which is
// exactly why this schedule and the burn history it's charted alongside are related at all.
export const TAX_SCHEDULE = [
  { supplyPct: 100, totalSupply: 1_000_000, buyTaxPct: 5.0, sellTaxPct: 10.0 },
  { supplyPct: 97.5, totalSupply: 975_000, buyTaxPct: 4.5, sellTaxPct: 9.6 },
  { supplyPct: 95, totalSupply: 950_000, buyTaxPct: 4.0, sellTaxPct: 9.2 },
  { supplyPct: 92.5, totalSupply: 925_000, buyTaxPct: 3.5, sellTaxPct: 8.8 },
  { supplyPct: 90, totalSupply: 900_000, buyTaxPct: 3.0, sellTaxPct: 8.4 },
  { supplyPct: 87.5, totalSupply: 875_000, buyTaxPct: 2.5, sellTaxPct: 8.0 },
  { supplyPct: 85, totalSupply: 850_000, buyTaxPct: 2.0, sellTaxPct: 7.6 },
  { supplyPct: 82.5, totalSupply: 825_000, buyTaxPct: 1.5, sellTaxPct: 7.2 },
  { supplyPct: 80, totalSupply: 800_000, buyTaxPct: 1.0, sellTaxPct: 6.8 },
  { supplyPct: 77.5, totalSupply: 775_000, buyTaxPct: 0.5, sellTaxPct: 6.4 },
  { supplyPct: 75, totalSupply: 750_000, buyTaxPct: 0, sellTaxPct: 6.0 },
  { supplyPct: 72.5, totalSupply: 725_000, buyTaxPct: 0, sellTaxPct: 5.6 },
  { supplyPct: 70, totalSupply: 700_000, buyTaxPct: 0, sellTaxPct: 5.2 },
  { supplyPct: 67.5, totalSupply: 675_000, buyTaxPct: 0, sellTaxPct: 4.8 },
  { supplyPct: 65, totalSupply: 650_000, buyTaxPct: 0, sellTaxPct: 4.4 },
  { supplyPct: 62.5, totalSupply: 625_000, buyTaxPct: 0, sellTaxPct: 4.0 },
  { supplyPct: 60, totalSupply: 600_000, buyTaxPct: 0, sellTaxPct: 3.6 },
  { supplyPct: 57.5, totalSupply: 575_000, buyTaxPct: 0, sellTaxPct: 3.2 },
  { supplyPct: 55, totalSupply: 550_000, buyTaxPct: 0, sellTaxPct: 2.8 },
  { supplyPct: 52.5, totalSupply: 525_000, buyTaxPct: 0, sellTaxPct: 2.4 },
  { supplyPct: 50, totalSupply: 500_000, buyTaxPct: 0, sellTaxPct: 2.0 },
];

async function resolveDeployBlock(tokenAddress) {
  try {
    const addr = await fetchBlockscoutJson(`/addresses/${tokenAddress}`);
    const txHash = addr?.creation_transaction_hash;
    if (!txHash) return null;
    const tx = await fetchBlockscoutJson(`/transactions/${txHash}`);
    return tx?.block_number != null ? Number(tx.block_number) : null;
  } catch (err) {
    console.warn("⚠️  CORE tax schedule: couldn't resolve deploy block:", err.message);
    return null;
  }
}

async function blockTimestampIso(provider, blockNumber) {
  const block = await provider.getBlock(blockNumber);
  return block ? new Date(block.timestamp * 1000).toISOString() : null;
}

/** Earliest block in [loBlock, hiBlock] where totalSupply() <= targetRaw — caller must already know
 * totalSupply(hiBlock) <= targetRaw (i.e. the threshold really has been crossed by now) or this
 * degenerates to hiBlock without ever confirming it. totalSupply is monotonically non-increasing
 * (burn-only), which is what makes ordinary binary search valid here. */
async function findCrossingBlock(contract, targetRaw, loBlock, hiBlock) {
  let lo = loBlock;
  let hi = hiBlock;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const supplyAtMid = await contract.totalSupply({ blockTag: mid });
    if (supplyAtMid <= targetRaw) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Returns the full schedule (both already-confirmed steps and not-yet-reached ones, the latter
 * with `crossedAtBlock`/`crossedAt: null`) — reads the cache only, never touches the chain. For
 * tokenBurnService.js's getTokenBurnHistory to attach to its CORE response. */
export async function getCoreTaxScheduleForDisplay() {
  const cache = await getCoreTaxScheduleCache();
  const foundByPct = new Map((cache?.steps || []).map((s) => [s.supplyPct, s]));
  return {
    steps: TAX_SCHEDULE.map((entry) => foundByPct.get(entry.supplyPct) || { ...entry, crossedAtBlock: null, crossedAt: null }),
    updatedAt: cache?.updatedAt || null,
  };
}

/** Does the actual on-chain work — binary-searches every threshold CORE's CURRENT supply has
 * reached but this cache hasn't confirmed yet, and publishes the merged (old + newly found)
 * result. Safe to re-run any time: already-found thresholds are skipped outright. Returns the
 * full merged step list, or null if CORE_TOKEN_ADDRESS isn't configured. */
export async function refreshCoreTaxSchedule() {
  if (!CORE_TOKEN_ADDRESS) {
    console.log("ℹ️  CORE_TOKEN_ADDRESS not set — CORE tax schedule refresh skipped");
    return null;
  }

  const provider = createArchiveRpcProvider({ batchMaxCount: 1 });
  const contract = new ethers.Contract(CORE_TOKEN_ADDRESS, ERC20_ABI, provider);
  const decimals = await contract.decimals().catch(() => 18);
  const scale = 10n ** BigInt(decimals);

  const existing = await getCoreTaxScheduleCache();
  const foundByPct = new Map((existing?.steps || []).map((s) => [s.supplyPct, s]));

  // Seed the 100% (deploy-time) entry — this is the token's starting state, not something to
  // binary-search for.
  if (!foundByPct.has(100)) {
    const deployBlock = (await resolveDeployBlock(CORE_TOKEN_ADDRESS)) ?? 0;
    const crossedAt = await blockTimestampIso(provider, deployBlock);
    foundByPct.set(100, { ...TAX_SCHEDULE[0], crossedAtBlock: deployBlock, crossedAt });
  }

  const latestBlock = await provider.getBlockNumber();
  const currentSupplyRaw = await contract.totalSupply();

  let searchFromBlock = foundByPct.get(100).crossedAtBlock;
  let newlyFound = 0;
  for (const entry of TAX_SCHEDULE) {
    if (entry.supplyPct === 100) continue;
    const already = foundByPct.get(entry.supplyPct);
    if (already) {
      searchFromBlock = already.crossedAtBlock;
      continue;
    }
    const targetRaw = BigInt(entry.totalSupply) * scale;
    if (currentSupplyRaw > targetRaw) break; // not yet reached — thresholds are strictly descending, nothing further is reached either
    const crossingBlock = await findCrossingBlock(contract, targetRaw, searchFromBlock, latestBlock);
    const crossedAt = await blockTimestampIso(provider, crossingBlock);
    foundByPct.set(entry.supplyPct, { ...entry, crossedAtBlock: crossingBlock, crossedAt });
    searchFromBlock = crossingBlock;
    newlyFound++;
  }

  const steps = TAX_SCHEDULE.filter((e) => foundByPct.has(e.supplyPct)).map((e) => foundByPct.get(e.supplyPct));
  await setCoreTaxScheduleCache(steps);
  console.log(`📉 CORE tax schedule refreshed — ${steps.length}/${TAX_SCHEDULE.length} threshold(s) confirmed on-chain (${newlyFound} newly found this run)`);
  return steps;
}

// Daily is generous for how slowly this schedule actually moves (months between new thresholds at
// realistic burn rates) — this exists so a newly-crossed threshold shows up within a day without
// anyone having to remember to re-run the manual script, not because it needs to be fresh sooner.
const REFRESH_INTERVAL_MS = process.env.CORE_TAX_SCHEDULE_INTERVAL_MS
  ? parseInt(process.env.CORE_TAX_SCHEDULE_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000;

export function startCoreTaxScheduleRefresh() {
  if (!CORE_TOKEN_ADDRESS) {
    console.log("ℹ️  CORE_TOKEN_ADDRESS not set — CORE tax schedule refresh disabled");
    return;
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — CORE tax schedule refresh disabled");
    return;
  }
  refreshCoreTaxSchedule().catch((err) => console.error("⚠️  CORE tax schedule refresh failed:", err.message));
  setInterval(() => {
    refreshCoreTaxSchedule().catch((err) => console.error("⚠️  CORE tax schedule refresh failed:", err.message));
  }, REFRESH_INTERVAL_MS);
}
