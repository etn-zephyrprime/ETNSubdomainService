import { query } from "./pool.js";

// Read-through cache of PremiumSubscription's two independent membership tiers, kept current by
// premiumSubscriptionWatcher.js from confirmed MembershipPurchased/AnnualMembershipPurchased
// events. The contract itself remains the source of truth for anything payment-critical (e.g. the
// contract's own isEligibleForDiscount() gates purchasePnlPeriods() pricing) — this table exists
// so the backend doesn't need a live eth_call every time it wants to show/report membership
// status. `tier` disambiguates which column a given upsert call updates — the two tiers are
// tracked independently since a wallet can hold both at once, and only annual grants the discount.

export async function upsertMembership(walletAddress, tier, expiryTimestamp, txHash) {
  if (tier !== "monthly" && tier !== "annual") throw new Error(`upsertMembership: unknown tier "${tier}"`);
  // Interpolated into the query below, but constrained to exactly one of these two hardcoded
  // literals by the check above — never derived from unsanitized input, so this isn't the
  // SQL-injection risk column-name interpolation usually is.
  const column = tier === "monthly" ? "monthly_expiry" : "annual_expiry";

  await query(
    `INSERT INTO premium_memberships (wallet_address, ${column}, last_tx_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (wallet_address) DO UPDATE
       SET ${column} = EXCLUDED.${column},
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

/** Every wallet with a currently-active Core Tier membership (either tier) — the complete universe
 * of Core Tier members, confirmed live to be MISSING from pnlSnapshotScheduler.js's own (and
 * several backfill scripts') prior approach of deriving "which owners to process" purely from
 * tracked_wallets rows: a member who has never explicitly tracked an additional wallet beyond
 * their own has NO tracked_wallets row at all, so they never appeared there — meaning the daily
 * scheduler never wrote them a single pnl_snapshots row, for their own wallet or otherwise, since
 * launch. Same monthly_expiry/annual_expiry "either tier, not just annual" OR logic hasCoreAccess
 * itself uses, just for every member at once instead of checking one wallet. */
export async function getAllActiveMemberWallets() {
  const res = await query(
    `SELECT wallet_address FROM premium_memberships WHERE monthly_expiry > now() OR annual_expiry > now()`
  );
  return (res?.rows || []).map((r) => r.wallet_address);
}
