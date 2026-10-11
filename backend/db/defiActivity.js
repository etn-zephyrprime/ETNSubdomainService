import { query, chunkArray } from "./pool.js";

// Raw yield-farm/staking events for a tracked wallet — see migrations/005_defi_activity.sql's own
// comment for why this exists as its own table (topic-based detection across the whole chain, not
// a per-contract-address feature).

// Max rows per INSERT statement — see pool.js's own chunkArray comment (a real production crash
// in the sibling ingestedTransfers.js table, not a preemptive guess). 500 * 9 columns = 4,500
// bound parameters, comfortably under the ~32,768 threshold that actually broke there.
const BATCH_SIZE = 500;

export async function insertDefiActivity(rows) {
  if (!rows || rows.length === 0) return;
  for (const batch of chunkArray(rows, BATCH_SIZE)) {
    const values = [];
    const params = [];
    let i = 1;
    for (const r of batch) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}, $${i++})`);
      params.push(
        r.trackedWallet.toLowerCase(),
        r.txHash,
        r.logIndex,
        r.contractAddress.toLowerCase(),
        r.eventType,
        r.farmId ?? null,
        JSON.stringify(r.rawArgs),
        r.blockNumber,
        r.timestamp
      );
    }
    await query(
      `INSERT INTO defi_activity
         (tracked_wallet, tx_hash, log_index, contract_address, event_type, farm_id, raw_args, block_number, "timestamp")
       VALUES ${values.join(",")}
       ON CONFLICT (tracked_wallet, tx_hash, log_index) DO NOTHING`,
      params
    );
  }
}

export async function getAllDefiActivityBefore(trackedWallet, beforeTs) {
  const res = await query(
    `SELECT * FROM defi_activity WHERE tracked_wallet = $1 AND "timestamp" < $2
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), beforeTs]
  );
  return res?.rows || [];
}

/** Every distinct (contract_address, farm_id) this wallet has ever deposited into (farm_deposit —
 * which also now covers a FarmIncrease top-up, see pnlIngestion.js) — the candidate list for
 * defiPositionValuation.js's live "is this still open, and if so what's it worth right now" check.
 * Deliberately NOT a source of truth for whether a position is still open (a farm_withdraw row
 * doesn't necessarily mean fully closed — could be partial) — that's always a live on-chain read;
 * this only tells the caller WHERE to look, cheaply, instead of brute-force scanning every farm ID
 * on every known farm contract for every wallet. */
export async function getDistinctFarmPositions(trackedWallet) {
  const res = await query(
    `SELECT DISTINCT contract_address, farm_id FROM defi_activity
     WHERE tracked_wallet = $1 AND event_type = 'farm_deposit' AND farm_id IS NOT NULL`,
    [trackedWallet.toLowerCase()]
  );
  return (res?.rows || []).map((r) => ({ contractAddress: r.contract_address, farmId: r.farm_id }));
}

/** Every distinct staking-template contract this wallet has ever staked at (core_staked) — same
 * "candidate list, not a source of truth" role as getDistinctFarmPositions above. */
export async function getDistinctStakingContracts(trackedWallet) {
  const res = await query(
    `SELECT DISTINCT contract_address FROM defi_activity WHERE tracked_wallet = $1 AND event_type = 'core_staked'`,
    [trackedWallet.toLowerCase()]
  );
  return (res?.rows || []).map((r) => r.contract_address);
}

/** Net quantity of a farm position's token0/token1 still genuinely "deposited" (not yet withdrawn)
 * — sum of every farm_deposit row's amount0Added/amount1Added (covers both a fresh FarmDeposit and
 * a FarmIncrease top-up — see pnlIngestion.js's own event_type mapping), minus every farm_withdraw
 * row's amount0Withdrawn/amount1Withdrawn, for this exact (contract, farmId, wallet). This is the
 * baseline defiPositionValuation.js's valueYieldFarmPosition compares a position's CURRENT (live,
 * pool-math) quantity against — see that function's own comment on why a USD-only figure can hide
 * an unfavorable token-quantity shift (confirmed live user concern: ETN pumping can make a position
 * read as "profitable" in USD even while the underlying CLUB/DYNO split has moved against you).
 * Raw string amounts (wei), summed as BigInt; floored at 0n per leg (a withdrawal can't legitimately
 * exceed what was deposited, but this guards against any rounding/edge-case drift rather than ever
 * showing a nonsensical negative baseline). */
export async function getFarmDepositedQuantities(trackedWallet, contractAddress, farmId) {
  const res = await query(
    `SELECT event_type, raw_args FROM defi_activity
     WHERE tracked_wallet = $1 AND contract_address = $2 AND farm_id = $3
       AND event_type IN ('farm_deposit', 'farm_withdraw')`,
    [trackedWallet.toLowerCase(), contractAddress.toLowerCase(), farmId]
  );
  let net0 = 0n;
  let net1 = 0n;
  for (const row of res?.rows || []) {
    const raw = row.raw_args || {};
    if (row.event_type === "farm_deposit") {
      if (raw.amount0Added) net0 += BigInt(raw.amount0Added);
      if (raw.amount1Added) net1 += BigInt(raw.amount1Added);
    } else {
      if (raw.amount0Withdrawn) net0 -= BigInt(raw.amount0Withdrawn);
      if (raw.amount1Withdrawn) net1 -= BigInt(raw.amount1Withdrawn);
    }
  }
  return { net0: net0 < 0n ? 0n : net0, net1: net1 < 0n ? 0n : net1 };
}

/** Every tx hash recorded for this wallet within [fromBlock, toBlock] — used by
 * doIngestDefiActivity (pnlIngestion.js) to assemble its returned defiTxHashes set from whatever's
 * actually in the table, regardless of which scan attempt's checkpoint inserted which rows (some
 * rows may have been persisted by an EARLIER, since-failed attempt via defi_scan_topic_progress's
 * own resume logic, not this run) — a single source of truth instead of re-deriving it from
 * in-memory logs that may no longer fully reflect what's been checkpointed so far. */
export async function getDefiActivityTxHashes(trackedWallet, fromBlock, toBlock) {
  const res = await query(
    `SELECT DISTINCT tx_hash FROM defi_activity WHERE tracked_wallet = $1 AND block_number BETWEEN $2 AND $3`,
    [trackedWallet.toLowerCase(), fromBlock, toBlock]
  );
  return new Set((res?.rows || []).map((r) => r.tx_hash.toLowerCase()));
}
