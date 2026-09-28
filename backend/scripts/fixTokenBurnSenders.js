// backend/scripts/fixTokenBurnSenders.js
//
// One-off correction for burn events stored BEFORE tokenBurnService.js's scanRange started
// preferring a transaction's own `from` (the EOA that actually signed and submitted it) over the
// raw Transfer log's `from` — see that fix's own header comment for why the log's `from` is
// frequently just an LP pool auto-forwarding a fee-on-transfer tax, not the real trader. Reported
// live: the Tokens tab's Top Burners table had an ElectroSwap LP pool address sitting at #1.
//
// This does NOT re-scan any blocks — every burn event already found is still a real burn, only its
// recorded sender can be wrong. For every token with stored burn events, it looks up each distinct
// transaction's real sender (one on-chain call per tx, not per row — a tx can contain more than one
// burn log) and overwrites `from_address` on every row that tx produced.
//
// Usage:
//   node backend/scripts/fixTokenBurnSenders.js
//
// Safe to re-run: a row whose sender is already correct is left untouched (no-op UPDATE).
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getDistinctTokensWithBurnEvents, getDistinctBurnTxHashes, updateBurnEventSender } from "../db/tokenBurns.js";

dotenv.config();

// Same reasoning as backfillTokenBurns.js's own step pacing — a burst of getTransaction calls is
// what tripped both RPC endpoints' own protection in a recent run; a small gap between calls here
// keeps this well clear of that.
const CALL_DELAY_MS = process.env.TOKEN_BURN_FIX_SENDERS_DELAY_MS ? parseInt(process.env.TOKEN_BURN_FIX_SENDERS_DELAY_MS, 10) : 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do (token_burn_events lives in Postgres).");
  }

  const provider = createRpcProvider({ batchMaxCount: 1 });
  const tokens = await getDistinctTokensWithBurnEvents();
  console.log(`${tokens.length} token(s) have stored burn events. Correcting sender addresses...\n`);

  let totalTx = 0;
  let totalFixed = 0;
  let totalFailed = 0;

  for (const [i, tokenAddress] of tokens.entries()) {
    const txHashes = await getDistinctBurnTxHashes(tokenAddress);
    let fixed = 0;
    let failed = 0;
    for (const txHash of txHashes) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx?.from) {
          const changed = await updateBurnEventSender(tokenAddress, txHash, tx.from);
          if (changed > 0) fixed += changed;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        console.warn(`  ⚠️  ${tokenAddress} / ${txHash}: ${err.message}`);
      }
      await sleep(CALL_DELAY_MS);
    }
    totalTx += txHashes.length;
    totalFixed += fixed;
    totalFailed += failed;
    console.log(`[${i + 1}/${tokens.length}] ${tokenAddress}: ${txHashes.length} tx checked, ${fixed} row(s) corrected${failed > 0 ? `, ${failed} lookup(s) failed` : ""}`);
  }

  console.log(`\nDone — ${totalTx} transaction(s) checked across ${tokens.length} token(s), ${totalFixed} row(s) corrected.`);
  if (totalFailed > 0) {
    console.log(`${totalFailed} lookup(s) failed and were left as-is — re-run this script to retry them (already-correct rows are instant no-ops).`);
  }

  await getPool().end();
}

main().catch((err) => {
  console.error("Sender correction failed:", err);
  process.exit(1);
});
