// Turns a liquidity-lock summary ({ count, permanentCount?, latestUnlockAt }) into what the Tokens
// tab actually shows. Shared by TokenLeaderboard.jsx (short badge) and TokenDetail.jsx (stat card).
//
// Burned liquidity comes back from ElectroSwap as a "lock" with a nonsense unlock time (a huge
// sentinel duration -> 18 Dec 12019, or zeroed fields -> 1 Jan 1970), not a real date — those are
// PERMANENT, shown as "Burned". backend/utils/tokenLiquidityLockRouter.js's normalizeLocks now
// counts them itself (`permanentCount`) and only ever puts a real date in `latestUnlockAt`; this
// also re-derives it from the date for summaries written before that (the R2 cache is only re-swept
// weekly, so old entries with a 12019/1970 date are still being served). Keep the bounds in sync
// with that file.
const MIN_PLAUSIBLE_UNLOCK_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_UNLOCK_YEARS = 100;

function isPlausibleUnlock(ms) {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_UNLOCK_MS && ms <= Date.now() + MAX_PLAUSIBLE_UNLOCK_YEARS * 365.25 * 24 * 60 * 60 * 1000;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** @returns {{ permanentCount: number, unlockMs: number|null }} — `unlockMs` is the latest REAL unlock date only. */
function resolveLock(lock) {
  const rawMs = lock.latestUnlockAt ? new Date(lock.latestUnlockAt).getTime() : null;
  const plausible = rawMs != null && isPlausibleUnlock(rawMs);
  // A legacy entry's implausible latest date means at least one (for 1970, every) lock is burned.
  const permanentCount = typeof lock.permanentCount === "number" ? lock.permanentCount : rawMs != null && !plausible ? lock.count : 0;
  return { permanentCount: Math.min(permanentCount, lock.count), unlockMs: plausible ? rawMs : null };
}

/** Short text for the list badge; null when there's nothing to show. */
export function lockBadgeText(lock) {
  if (!lock || lock.count === 0) return null;
  const { permanentCount, unlockMs } = resolveLock(lock);
  if (permanentCount > 0 && unlockMs != null) return `Burned + until ${formatDate(unlockMs)}`;
  if (permanentCount > 0) return "Burned";
  if (unlockMs != null) return `Until ${formatDate(unlockMs)}`;
  return `${lock.count} lock${lock.count === 1 ? "" : "s"}`;
}

/** Full text for TokenDetail's Liquidity Lock card. */
export function lockStatusText(lock) {
  if (!lock) return "Checking…";
  if (!lock.available) return "Unavailable";
  if (lock.count === 0) return "No locks found";
  const { permanentCount, unlockMs } = resolveLock(lock);
  if (permanentCount > 0 && unlockMs != null) return `Burned + locked until ${formatDate(unlockMs)}`;
  if (permanentCount > 0) return "Burned (permanent)";
  if (unlockMs != null) return `Locked until ${formatDate(unlockMs)}`;
  return `${lock.count} lock${lock.count === 1 ? "" : "s"} found`;
}
