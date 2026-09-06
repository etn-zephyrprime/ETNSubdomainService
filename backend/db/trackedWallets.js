import { query } from "./pool.js";

// See migrations/007_tracked_wallets.sql's own header comment for why this is one row per
// add/remove cycle rather than one row per member — that history is what makes both cooldowns
// below checkable at all.
export const MAX_TRACKED_WALLETS = 3;
export const TRACK_COOLDOWN_DAYS = 30;
const TRACK_COOLDOWN_MS = TRACK_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function addMs(date, ms) {
  return new Date(new Date(date).getTime() + ms);
}

/** Currently-tracked wallets, oldest-added first, each with when its hold period ends. */
export async function getActiveTrackedWallets(ownerWallet) {
  const res = await query(
    `SELECT wallet_address, added_at FROM tracked_wallets
     WHERE owner_wallet = $1 AND removed_at IS NULL
     ORDER BY added_at ASC`,
    [ownerWallet.toLowerCase()]
  );
  return (res?.rows || []).map((r) => ({
    address: r.wallet_address,
    addedAt: r.added_at,
    removableAt: addMs(r.added_at, TRACK_COOLDOWN_MS),
  }));
}

/** Wallets untracked recently enough that their re-track cooldown hasn't cleared yet — surfaced
 * so the UI can explain *why* re-adding one is blocked instead of just rejecting it. */
export async function getCoolingDownWallets(ownerWallet) {
  const res = await query(
    `SELECT DISTINCT ON (wallet_address) wallet_address, removed_at
     FROM tracked_wallets
     WHERE owner_wallet = $1 AND removed_at IS NOT NULL AND removed_at > now() - ($2 || ' milliseconds')::interval
     ORDER BY wallet_address, removed_at DESC`,
    [ownerWallet.toLowerCase(), TRACK_COOLDOWN_MS]
  );
  return (res?.rows || []).map((r) => ({
    address: r.wallet_address,
    removedAt: r.removed_at,
    retrackableAt: addMs(r.removed_at, TRACK_COOLDOWN_MS),
  }));
}

/** Starts tracking `walletAddress` for `ownerWallet` — throws a plain, safe-to-return-to-the-
 * client Error for every rejection reason (cap reached, already tracked, still cooling down from
 * a recent untrack) rather than a generic failure, so the caller (premiumDashboardRouter.js) can
 * pass the real reason straight through. */
export async function addTrackedWallet(ownerWallet, walletAddress) {
  const owner = ownerWallet.toLowerCase();
  const address = walletAddress.toLowerCase();

  const active = await getActiveTrackedWallets(owner);
  if (active.some((w) => w.address === address)) {
    throw new Error("Already tracking that wallet");
  }
  if (active.length >= MAX_TRACKED_WALLETS) {
    throw new Error(`You can track up to ${MAX_TRACKED_WALLETS} wallets — untrack one first`);
  }

  const cooling = await getCoolingDownWallets(owner);
  const stillCooling = cooling.find((w) => w.address === address);
  if (stillCooling) {
    throw new Error(
      `You untracked this wallet recently — it can't be re-tracked until ${stillCooling.retrackableAt.toISOString().slice(0, 10)}`
    );
  }

  await query(
    `INSERT INTO tracked_wallets (owner_wallet, wallet_address) VALUES ($1, $2)`,
    [owner, address]
  );
  return getActiveTrackedWallets(owner);
}

/** Stops tracking `walletAddress` for `ownerWallet` — throws if it isn't currently tracked, or if
 * its 30-day hold period hasn't elapsed yet. */
export async function removeTrackedWallet(ownerWallet, walletAddress) {
  const owner = ownerWallet.toLowerCase();
  const address = walletAddress.toLowerCase();

  const res = await query(
    `SELECT id, added_at FROM tracked_wallets WHERE owner_wallet = $1 AND wallet_address = $2 AND removed_at IS NULL`,
    [owner, address]
  );
  const row = res?.rows[0];
  if (!row) {
    throw new Error("That wallet isn't currently tracked");
  }

  const removableAt = addMs(row.added_at, TRACK_COOLDOWN_MS);
  if (removableAt.getTime() > Date.now()) {
    throw new Error(
      `This wallet was added on ${new Date(row.added_at).toISOString().slice(0, 10)} — it can't be untracked until ${removableAt.toISOString().slice(0, 10)}`
    );
  }

  await query(`UPDATE tracked_wallets SET removed_at = now() WHERE id = $1`, [row.id]);
  return getActiveTrackedWallets(owner);
}
