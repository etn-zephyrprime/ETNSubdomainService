// Pure series/forecast maths for the ETN Bridge tab — no React or Vite imports, so it can be unit-tested
// with plain node.
//
// The published file (backend/utils/etnBridge.js) records CUMULATIVE ETN MIGRATED over time. The chart shows
// the mirror image: ETN REMAINING in the bridge, falling towards the goal of 0 by the deadline.
//   total     = migrated + remaining, constant (the bridge's balance is only ever paid out)
//   remaining = total - migrated(t)

// Legacy-chain ETN can be migrated until this date (end of day, UTC).
export const DEADLINE_DAY = "2027-01-31";
export const DEADLINE_MS = Date.parse(`${DEADLINE_DAY}T23:59:59Z`);
// The proxy's creation day — the chart's left edge if the file has no earlier point.
export const FALLBACK_START_DAY = "2024-03-03";

const DAY_MS = 86400000;
export const FORECAST_WINDOW_DAYS = 30;

/** A published point's time in ms. A date-only key ("2026-09-17") is the reading at that day's LAST block,
 * so it sits at the end of the day; a full ISO timestamp is exact. */
export function pointTime(t) {
  const s = String(t);
  return s.length <= 10 ? Date.parse(`${s}T23:59:59Z`) : Date.parse(s);
}

/** Total ETN that was ever in the bridge, from the latest reading: migrated + still-remaining. */
export function bridgeTotal(current) {
  if (!current || !Number.isFinite(current.migratedEtn) || !Number.isFinite(current.balanceEtn)) return null;
  return current.migratedEtn + current.balanceEtn;
}

/** Published points -> `[{ t (ms), migrated, remaining }]` ascending. `remaining` is clamped to [0, total] and
 * forced non-increasing (a lagging node reading can never draw the line going back UP). Malformed points are
 * dropped. Empty when `total` is unknown. */
export function buildRemainingSeries(points, total) {
  if (!Array.isArray(points) || !Number.isFinite(total)) return [];
  const rows = [];
  for (const p of points) {
    const t = pointTime(p?.t);
    if (!Number.isFinite(t) || !Number.isFinite(p?.migratedEtn)) continue;
    rows.push({ t, migrated: p.migratedEtn });
  }
  rows.sort((a, b) => a.t - b.t);
  const out = [];
  let floor = -Infinity; // migrated is cumulative: never let it go backwards
  for (const r of rows) {
    const migrated = Math.min(total, Math.max(floor, r.migrated));
    floor = migrated;
    if (out.length && out[out.length - 1].t === r.t) out.pop();
    out.push({ t: r.t, migrated, remaining: total - migrated });
  }
  return out;
}

/** Migrated ETN per day over the trailing `windowDays` up to the last point (or null with too little
 * history). Uses the last point at or before the window start so a sparse series still gives a fair rate. */
export function trailingPacePerDay(series, windowDays = FORECAST_WINDOW_DAYS) {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const target = last.t - windowDays * DAY_MS;
  let base = series[0];
  for (const p of series) {
    if (p.t <= target) base = p;
    else break;
  }
  const days = (last.t - base.t) / DAY_MS;
  if (days < 1) return null;
  return Math.max(0, (base.remaining - last.remaining) / days);
}

/** Where the bridge is heading. `nowMs` is the last reading's time, `remaining` its balance.
 *  - pacePerDay: trailing-window pace (ETN/day migrated)
 *  - requiredPerDay: pace needed to reach 0 by the deadline
 *  - forecast: dashed line from now to the deadline at the current pace (clamped at 0)
 *  - requiredLine: the straight path from now to 0 at the deadline
 *  - projectedAtDeadline: remaining ETN on the deadline at the current pace
 *  - zeroAtMs: when the current pace would empty the bridge (null if never / no pace)
 *  - onTrack: current pace is enough to hit 0 by the deadline
 * Returns null when there's no data or the deadline has passed. */
export function computeForecast({ series, nowMs, deadlineMs = DEADLINE_MS, windowDays = FORECAST_WINDOW_DAYS }) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  const now = Number.isFinite(nowMs) ? nowMs : last.t;
  const daysLeft = (deadlineMs - now) / DAY_MS;
  if (daysLeft <= 0) return null;

  const pace = trailingPacePerDay(series, windowDays);
  const requiredPerDay = last.remaining / daysLeft;
  const projectedAtDeadline = pace === null ? null : Math.max(0, last.remaining - pace * daysLeft);
  const daysToZero = pace ? last.remaining / pace : null;
  const zeroAtMs = daysToZero === null ? null : now + daysToZero * DAY_MS;

  const forecast = pace === null ? [] : [
    { t: now, remaining: last.remaining },
    { t: deadlineMs, remaining: projectedAtDeadline },
  ];
  const requiredLine = [
    { t: now, remaining: last.remaining },
    { t: deadlineMs, remaining: 0 },
  ];

  return {
    pacePerDay: pace,
    requiredPerDay,
    daysLeft,
    projectedAtDeadline,
    zeroAtMs,
    onTrack: pace !== null && pace >= requiredPerDay,
    forecast,
    requiredLine,
  };
}

/** The remaining ETN at time `t`: linear between neighbouring points inside the recorded range, null
 * outside it. For the chart tooltip. */
export function valueAt(series, t) {
  if (!series.length || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t) return a.remaining;
  return a.remaining + ((b.remaining - a.remaining) * (t - a.t)) / (b.t - a.t);
}

/** "Nice" y-axis ticks from 0 up to `total`: 0 and quarters of the total. */
export function yTicks(total) {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => total * f);
}

/** X-axis month ticks (UTC, 1st of the month) every `everyMonths` months between two times, skipping any
 * closer than `minGapMs` to `avoidMs` (the deadline marker has its own label). */
export function monthTicks(startMs, endMs, everyMonths = 6, { avoidMs, minGapMs = 45 * DAY_MS } = {}) {
  const start = new Date(startMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  m = Math.ceil(m / everyMonths) * everyMonths; // align to Jan/Jul for 6-monthly
  const ticks = [];
  for (let i = 0; i < 100; i++) {
    const yy = y + Math.floor(m / 12);
    const t = Date.UTC(yy, m % 12, 1);
    if (t > endMs) break;
    if (t >= startMs && !(avoidMs !== undefined && Math.abs(t - avoidMs) < minGapMs)) ticks.push(t);
    m += everyMonths;
  }
  return ticks;
}
