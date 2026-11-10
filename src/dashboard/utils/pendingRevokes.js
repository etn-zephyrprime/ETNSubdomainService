// Revokes queued for a wallet other than the one connected. Approvals of a Core member's TRACKED wallets are
// listed while the member's own wallet is connected (that's what unlocks Core Tier), but only the tracked
// wallet itself can sign the revoke — so a revoke for it is saved here, on this device, and offered once the
// member switches their wallet app to that address (PendingRevokes in CoreTierContracts.jsx, which sits
// outside the Core gate and calls no Argus API — everything stored is public on-chain data).
//
// Browser storage only: it can be unavailable (private window, blocked storage), so every access is guarded
// and the feature simply does nothing then.
const KEY = "argus.pendingRevokes.v1";
const MAX_AGE_MS = 14 * 86400000; // stale entries are dropped
const subscribers = new Set();

const keyOf = (r) => `${r.owner}|${r.token}|${r.spender}|${r.kind}|${r.tokenId ?? ""}`.toLowerCase();

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((r) => r && Date.now() - (r.addedAt || 0) < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable — nothing to persist
  }
  subscribers.forEach((fn) => fn(list));
}

/** All pending revokes (or only `owner`'s). */
export function getPendingRevokes(owner = null) {
  const list = read();
  return owner ? list.filter((r) => r.owner.toLowerCase() === owner.toLowerCase()) : list;
}

/** Queue one: { owner, token, spender, kind, tokenId?, tokenLabel, spenderLabel, allowanceLabel }. */
export function addPendingRevoke(r) {
  const list = read().filter((x) => keyOf(x) !== keyOf(r));
  write([...list, { ...r, addedAt: Date.now() }]);
}

export function removePendingRevoke(r) {
  write(read().filter((x) => keyOf(x) !== keyOf(r)));
}

export const isPendingRevoke = (r) => read().some((x) => keyOf(x) === keyOf(r));

/** Re-render on change: returns an unsubscribe. */
export function subscribePendingRevokes(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
