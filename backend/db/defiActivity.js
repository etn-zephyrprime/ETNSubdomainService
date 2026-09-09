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
