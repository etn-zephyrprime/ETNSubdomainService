import { query } from "./pool.js";

// Transparency log for every executed buy-and-burn split — the brief's own "log every buy-and-burn
// execution" requirement. One row per FINALIZED request that had a non-zero amount to split;
// existence of a row here is also the split scheduler's own idempotency guard (see
// statementRequests.findFinalizedNeedingSplit).

/** Total CORE actually burned via this contract's own executeSplitForPeriod flow specifically —
 * not any other burn source in the ecosystem (ElectroSwap fees, CoreClashGame's 1% burn, etc.),
 * which is exactly why this reads buy_and_burn_log rather than some site-wide burn total. Powers
 * the PnL Statements tab's "CORE Burned" card. */
export async function getTotalCoreBurned() {
  const res = await query(`SELECT COALESCE(SUM(core_burned), 0) AS total FROM buy_and_burn_log`);
  return res?.rows[0]?.total || "0";
}

export async function insertBuyAndBurnLog({
  statementRequestId,
  splitWalletAmountWei,
  swapAndBurnTxHash,
  ethSwappedWei,
  coreReceived,
  coreBurned,
  operatorAddress,
}) {
  await query(
    `INSERT INTO buy_and_burn_log
       (statement_request_id, split_wallet_amount_wei, swap_and_burn_tx_hash, eth_swapped_wei,
        core_received, core_burned, operator_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (statement_request_id) DO NOTHING`,
    [
      statementRequestId,
      splitWalletAmountWei.toString(),
      swapAndBurnTxHash,
      ethSwappedWei.toString(),
      coreReceived,
      coreBurned,
      operatorAddress.toLowerCase(),
    ]
  );
}
