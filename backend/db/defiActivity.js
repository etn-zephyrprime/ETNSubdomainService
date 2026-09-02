import { query } from "./pool.js";

// Raw yield-farm/staking events for a tracked wallet — see migrations/005_defi_activity.sql's own
// comment for why this exists as its own table (topic-based detection across the whole chain, not
// a per-contract-address feature).

export async function insertDefiActivity(rows) {
  if (!rows || rows.length === 0) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const r of rows) {
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

export async function getAllDefiActivityBefore(trackedWallet, beforeTs) {
  const res = await query(
    `SELECT * FROM defi_activity WHERE tracked_wallet = $1 AND "timestamp" < $2
     ORDER BY "timestamp" ASC, log_index ASC`,
    [trackedWallet.toLowerCase(), beforeTs]
  );
  return res?.rows || [];
}
