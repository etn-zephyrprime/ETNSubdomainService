import { query } from "./pool.js";

// Read-through cache of PremiumSubscription.membershipExpiry, kept current by
// premiumSubscriptionWatcher.js from confirmed MembershipPurchased events. The contract itself
// remains the source of truth for anything payment-critical (e.g. the contract's own
// isMembershipActive() gates purchasePnlPeriods() pricing) — this table exists so the backend
// doesn't need a live eth_call every time it wants to show/report membership status.

export async function upsertMembership(walletAddress, expiryTimestamp, txHash) {
  await query(
    `INSERT INTO premium_memberships (wallet_address, expiry_timestamp, last_tx_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (wallet_address) DO UPDATE
       SET expiry_timestamp = EXCLUDED.expiry_timestamp,
           last_tx_hash = EXCLUDED.last_tx_hash,
           updated_at = now()`,
    [walletAddress.toLowerCase(), expiryTimestamp, txHash]
  );
}

export async function getMembership(walletAddress) {
  const res = await query("SELECT * FROM premium_memberships WHERE wallet_address = $1", [
    walletAddress.toLowerCase(),
  ]);
  return res?.rows[0] || null;
}
