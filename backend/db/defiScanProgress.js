import { query } from "./pool.js";

// Per-(wallet, topic) checkpoint for pnlIngestion.js's doIngestDefiActivity — see
// migrations/020_defi_scan_topic_progress.sql's own comment for why this exists: without it, one
// topic's getLogs call exhausting all 3 RPC failover tiers mid-scan discarded every sibling topic's
// already-fetched data too, forcing a full from-block-zero restart on every retry.

export async function getDefiTopicProgress(trackedWallet, topicLabel) {
  const { rows } = await query(
    `SELECT scan_from_block, last_completed_block FROM defi_scan_topic_progress WHERE tracked_wallet = $1 AND topic_label = $2`,
    [trackedWallet.toLowerCase(), topicLabel]
  );
  if (rows.length === 0) return null;
  return { scanFromBlock: Number(rows[0].scan_from_block), lastCompletedBlock: Number(rows[0].last_completed_block) };
}

export async function saveDefiTopicProgress(trackedWallet, topicLabel, scanFromBlock, lastCompletedBlock) {
  await query(
    `INSERT INTO defi_scan_topic_progress (tracked_wallet, topic_label, scan_from_block, last_completed_block, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tracked_wallet, topic_label)
     DO UPDATE SET scan_from_block = $3, last_completed_block = $4, updated_at = now()`,
    [trackedWallet.toLowerCase(), topicLabel, scanFromBlock, lastCompletedBlock]
  );
}

// Must be called everywhere defi_activity itself is cleared for a wallet (resetDefiAffectedWallets.js,
// resetV3NativeFundedMintWallets.js, resetV3NftMisclassifiedWallets.js) — see this table's own
// migration comment for why a stale row here is actively harmful post-reset, not just inert.
export async function clearDefiTopicProgress(trackedWallet) {
  await query("DELETE FROM defi_scan_topic_progress WHERE tracked_wallet = $1", [trackedWallet.toLowerCase()]);
}
