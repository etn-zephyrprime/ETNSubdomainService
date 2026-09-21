// Pure helpers behind the small "7D +5.2%" markers on the Overview tiles — no React/Vite imports so they can be
// unit-tested with plain node. Every change is (now - 7 days ago) / 7 days ago * 100, or null when there isn't
// genuine data about a week back (never an estimate — a tile with too little history says "7D —").
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const TOLERANCE_MS = 12 * HOUR_MS; // how far from exactly-7-days-ago a reference reading may sit

const timeOf = (t) => (String(t).length <= 10 ? Date.parse(`${t}T00:00:00Z`) : Date.parse(t));

/** Percent change from `previous` to `current`; null unless both are finite and `previous` is positive. */
export function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** The item whose time is closest to `targetMs`, within `toleranceMs`, else null. `getTime(item)` -> ms. */
export function nearestTo(items, targetMs, getTime, toleranceMs = TOLERANCE_MS) {
  let best = null;
  let bestGap = Infinity;
  for (const item of items || []) {
    const gap = Math.abs(getTime(item) - targetMs);
    if (gap <= toleranceMs && gap < bestGap) {
      best = item;
      bestGap = gap;
    }
  }
  return best;
}

/** 7-day changes for the tiles fed by the hourly network snapshots (backend dashboardStatsCache.js):
 * `{ totalTx, totalAddresses, totalBlocks, avgBlockTime, gasPrice, txsLast7d }`, each a percent or null.
 * `current` may override the "now" values with fresher live readings (`{ totalTransactions, totalAddresses,
 * totalBlocks, averageBlockTimeMs, gasPriceAverage }`); anything omitted comes from the newest snapshot.
 * `txsLast7d` compares the last 7 days' transactions with the 7 days before them. */
export function snapshotChanges(snapshots, current = {}) {
  const empty = { totalTx: null, totalAddresses: null, totalBlocks: null, avgBlockTime: null, gasPrice: null, txsLast7d: null };
  const sorted = (snapshots || []).filter((s) => Number.isFinite(timeOf(s?.timestamp))).sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));
  if (sorted.length === 0) return empty;

  const latest = sorted[sorted.length - 1];
  const nowMs = timeOf(latest.timestamp);
  const getTime = (s) => timeOf(s.timestamp);
  const weekAgo = nearestTo(sorted, nowMs - 7 * DAY_MS, getTime);
  const twoWeeksAgo = nearestTo(sorted, nowMs - 14 * DAY_MS, getTime);
  const now = { ...latest, ...Object.fromEntries(Object.entries(current).filter(([, v]) => Number.isFinite(v))) };

  const out = { ...empty };
  if (weekAgo) {
    out.totalTx = pctChange(now.totalTransactions, weekAgo.totalTransactions);
    out.totalAddresses = pctChange(now.totalAddresses, weekAgo.totalAddresses);
    out.totalBlocks = pctChange(now.totalBlocks, weekAgo.totalBlocks);
    out.avgBlockTime = pctChange(now.averageBlockTimeMs, weekAgo.averageBlockTimeMs);
    out.gasPrice = pctChange(now.gasPriceAverage, weekAgo.gasPriceAverage);
    if (twoWeeksAgo) {
      out.txsLast7d = pctChange(now.totalTransactions - weekAgo.totalTransactions, weekAgo.totalTransactions - twoWeeksAgo.totalTransactions);
    }
  }
  return out;
}

/** Change in the distinct-validator count over the last 7 days. `days` is validatorRewardsCache.js's
 * `{ "YYYY-MM-DD": { validators: { address: ... } } }`; the tile counts distinct validators seen across every
 * day published, so "a week ago" is the same count over only the days up to 7 days before the newest one. */
export function validatorCountChange(days) {
  const keys = Object.keys(days || {}).sort();
  if (keys.length === 0) return null;
  const newest = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
  const cutoff = newest - 7 * DAY_MS;
  const all = new Set();
  const before = new Set();
  for (const key of keys) {
    const inWindow = Date.parse(`${key}T00:00:00Z`) <= cutoff;
    for (const address of Object.keys(days[key]?.validators || {})) {
      all.add(address);
      if (inWindow) before.add(address);
    }
  }
  return keys.some((k) => Date.parse(`${k}T00:00:00Z`) <= cutoff) ? pctChange(all.size, before.size) : null;
}

/** "+5.2%", "-12%", "0%" — one decimal below 10%, whole numbers above; an em dash for null. */
export function formatChange(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const abs = Math.abs(pct);
  if (abs < 0.05) return "0%";
  const sign = pct > 0 ? "+" : "-";
  if (abs < 10) return `${sign}${abs.toFixed(1)}%`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k%`;
  return `${sign}${Math.round(abs)}%`;
}
