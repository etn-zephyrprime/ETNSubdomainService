import { query } from "./pool.js";

// One row per member (owner_wallet = the member's own connected/verified wallet — see
// walletAuth.js), holding the list of addresses they want combined into the Core tier portfolio
// view (see premiumDashboardRouter.js). Deliberately NOT scoped to "wallets the member can prove
// they own" — the whole point is being able to watch e.g. a cold-storage or a friend's wallet
// alongside your own, so this only ever requires proving ownership of owner_wallet itself, never
// of the wallets being tracked.
export const MAX_TRACKED_WALLETS = 3;

export async function getTrackedWallets(ownerWallet) {
  const res = await query("SELECT wallets FROM tracked_wallets WHERE owner_wallet = $1", [
    ownerWallet.toLowerCase(),
  ]);
  return res?.rows[0]?.wallets || [];
}

/** Replaces the member's whole tracked-wallet list (not an incremental add/remove) — the caller
 * (premiumDashboardRouter.js) already validates each address and the MAX_TRACKED_WALLETS cap
 * before this is called; de-duped and lowercased here too as defense-in-depth against whatever
 * reaches this function directly (e.g. a future script). */
export async function setTrackedWallets(ownerWallet, wallets) {
  const deduped = [...new Set(wallets.map((w) => w.toLowerCase()))];
  if (deduped.length > MAX_TRACKED_WALLETS) {
    throw new Error(`Cannot track more than ${MAX_TRACKED_WALLETS} wallets`);
  }

  const res = await query(
    `INSERT INTO tracked_wallets (owner_wallet, wallets, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (owner_wallet) DO UPDATE
       SET wallets = EXCLUDED.wallets,
           updated_at = now()
     RETURNING wallets`,
    [ownerWallet.toLowerCase(), JSON.stringify(deduped)]
  );
  return res?.rows[0]?.wallets || deduped;
}
