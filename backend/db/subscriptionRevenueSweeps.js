import { query } from "./pool.js";

/** Every executed sweep, most recent first — the sweep scheduler's own audit trail (see
 * migrations/008_subscription_revenue_sweeps.sql for why balance/owed are recorded alongside the
 * swept amount, not just the amount itself). */
export async function getRecentSweeps(limit = 20) {
  const res = await query(
    `SELECT * FROM subscription_revenue_sweeps ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return res?.rows || [];
}

export async function insertSubscriptionRevenueSweep({
  amountSweptWei,
  balanceAtSweepWei,
  pnlOwedAtSweepWei,
  blockNumber,
  swapAndBurnTxHash,
  coreReceived,
  coreBurned,
  operatorAddress,
}) {
  await query(
    `INSERT INTO subscription_revenue_sweeps
       (amount_swept_wei, balance_at_sweep_wei, pnl_owed_at_sweep_wei, block_number,
        swap_and_burn_tx_hash, core_received, core_burned, operator_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      amountSweptWei.toString(),
      balanceAtSweepWei.toString(),
      pnlOwedAtSweepWei.toString(),
      blockNumber,
      swapAndBurnTxHash,
      coreReceived,
      coreBurned,
      operatorAddress.toLowerCase(),
    ]
  );
}
