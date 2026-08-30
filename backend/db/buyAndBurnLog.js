import { query } from "./pool.js";

// Transparency log for every executed buy-and-burn split — the brief's own "log every buy-and-burn
// execution" requirement. One row per FINALIZED request that had a non-zero amount to split;
// existence of a row here is also the split scheduler's own idempotency guard (see
// statementRequests.findFinalizedNeedingSplit).

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
