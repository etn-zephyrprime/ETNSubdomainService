// backend/utils/tvlHistory.js
//
// Total value locked (TVL) in ElectroSwap's pools, tracked over time for the Overview tab's TVL tile.
//
// WHAT TVL MEANS HERE: the USD value of the tokens held by ElectroSwap's V2 and V3 liquidity pools —
// each pool counted once. (Staked CORE and yield-farm deposits aren't added: a farm holds LP tokens,
// and the pool behind those is already counted; the staking contract's own-token stake is excluded by
// the same convention DefiLlama uses for "TVL".) It's computed live, hourly, by tokenLiquidityCache.js
// (which already reads every pool's balances on-chain and prices them) and recorded here.
//
// HISTORY. Two sources, both stored as one series of points `{ t, tvlUsd, pools?, src? }`:
//  - live: one point per hourly run (t = full ISO timestamp), this dashboard's own measurement;
//  - backfill: DefiLlama's daily TVL for Electroneum (ElectroSwap V2 + V3 — the same definition),
//    2024-09-14 onward (t = "YYYY-MM-DD", src "defillama"), fetched once on first start. A live point
//    always wins over a backfilled one for the same day; the two methodologies differ slightly (own
//    pricing/pool coverage vs DefiLlama's), so a small step can appear where they meet — expected, and
//    the tile's caption says which is which.
//
// Storage keeps hourly points for RECENT_HOURLY_DAYS and collapses older ones to one per UTC day, so
// the file stays small. The chart itself is drawn at daily resolution (the chart component places
// points by index, so mixing dense hourly points with sparse daily ones would squash the recent weeks).
import { getTvlHistory, setTvlHistory } from "../state/tvlHistoryState.js";

const DEFILLAMA_CHAIN_TVL_URL = "https://api.llama.fi/v2/historicalChainTvl/Electroneum";
const RECENT_HOURLY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

/** "2026-09-20" for either a date-only key or a full ISO timestamp. */
export const dayKey = (t) => String(t).slice(0, 10);
const timeOf = (t) => (String(t).length <= 10 ? Date.parse(`${t}T00:00:00Z`) : Date.parse(t));

/** Sorted ascending by time, one entry per exact `t`. Exported for tests. */
export function sortPoints(points) {
  const byT = new Map();
  for (const p of points) if (p && Number.isFinite(p.tvlUsd) && Number.isFinite(timeOf(p.t))) byT.set(p.t, p);
  return [...byT.values()].sort((a, b) => timeOf(a.t) - timeOf(b.t));
}

/** Keeps every hourly point from the last RECENT_HOURLY_DAYS; for older days keeps only the LAST point
 * of each UTC day, re-keyed date-only when it was a full timestamp. Pure. Exported for tests. */
export function compactPoints(points, now = Date.now()) {
  const sorted = sortPoints(points);
  const cutoff = now - RECENT_HOURLY_DAYS * DAY_MS;
  const recent = [];
  const lastOfOldDay = new Map(); // day -> point (sorted ascending, so the last write wins)
  for (const p of sorted) {
    if (timeOf(p.t) >= cutoff) recent.push(p);
    else lastOfOldDay.set(dayKey(p.t), { ...p, t: dayKey(p.t) });
  }
  return [...lastOfOldDay.values(), ...recent];
}

/** Whether a fresh live measurement looks trustworthy enough to record. Two failure modes it screens:
 *  - DEGRADED PRICING: TVL only counts pools it could PRICE; when ElectroSwap pricing is degraded (an
 *    outage, a rate-limit pause) most pools go unpriced and TVL would plunge for a reason that has
 *    nothing to do with the pools — the same failure mode generateDemoSnapshot.js guards against. So a
 *    point that values fewer than 70% of the pools the recent live points did (median of the last 24)
 *    is skipped.
 *  - A WILD JUMP: a junk token with a nonsense price can inflate one pool, and a bad price feed can
 *    collapse everything; a real pool base doesn't move 5x (or drop 80%) inside an hour. Compared with
 *    the last live point.
 * Returns { ok, reason }. Pure. Exported for tests. */
export function assessLivePoint(candidate, points) {
  const live = points.filter((p) => p.src !== "defillama");
  const recentLive = live.filter((p) => Number.isFinite(p.pools)).slice(-24);
  if (recentLive.length >= 3) {
    const sortedPools = recentLive.map((p) => p.pools).sort((a, b) => a - b);
    const median = sortedPools[Math.floor(sortedPools.length / 2)];
    if (candidate.pools < median * 0.7) {
      return { ok: false, reason: `only ${candidate.pools} pool(s) valued vs a recent median of ${median} — pricing looks degraded` };
    }
  }
  const last = live[live.length - 1];
  if (last && last.tvlUsd > 0) {
    const ratio = candidate.tvlUsd / last.tvlUsd;
    if (ratio > 5 || ratio < 0.2) {
      return { ok: false, reason: `TVL moved ${ratio.toFixed(2)}x since the last recorded point ($${Math.round(last.tvlUsd).toLocaleString()} -> $${Math.round(candidate.tvlUsd).toLocaleString()}) — treating as a bad reading` };
    }
  }
  return { ok: true, reason: live.length === 0 ? "first live point" : "in line with recent runs" };
}

/** DefiLlama's series has adapter glitches — confirmed live: three consecutive $0 days (2026-07-07..09)
 * and a day at $13.9k between neighbours of ~$110k (2026-06-09). Published as fact they'd read as the
 * pools emptying and refilling. A day is a glitch when it's zero/negative or far outside the median of
 * its (up to) 3 valid neighbours either side: below 30% or above 3.5x of it. Real moves don't do that
 * in a day (the 2025 run from ~$75k to ~$570k took weeks; a sustained crash drags its own neighbours
 * into the median). Glitches are replaced by linear interpolation between the nearest good days so the
 * daily series stays evenly spaced, and flagged `est: true`; a glitch with no good day on one side (the
 * very first/last day) is dropped instead. `days` must be ascending. Pure. Exported for tests. */
export function sanitizeDailyTvl(days) {
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const n = days.length;
  const bad = new Set();
  for (let i = 0; i < n; i++) {
    const v = days[i].tvlUsd;
    if (!(v > 0)) { bad.add(i); continue; }
    const around = [];
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (k !== i && days[k].tvlUsd > 0) around.push(days[k].tvlUsd);
    if (around.length < 3) continue; // not enough context to judge
    const m = median(around);
    if (v < m * 0.3 || v > m * 3.5) bad.add(i);
  }
  const out = [];
  let fixed = 0;
  for (let i = 0; i < n; i++) {
    if (!bad.has(i)) { out.push(days[i]); continue; }
    let l = i - 1; while (l >= 0 && bad.has(l)) l--;
    let r = i + 1; while (r < n && bad.has(r)) r++;
    if (l < 0 || r >= n) continue; // nothing on one side to interpolate from — drop it
    const t = (i - l) / (r - l);
    out.push({ date: days[i].date, tvlUsd: days[l].tvlUsd + (days[r].tvlUsd - days[l].tvlUsd) * t, est: true });
    fixed++;
  }
  return { days: out, fixed, dropped: n - out.length };
}

/** Inserts backfilled daily points for every day that has NO point yet (live points always win, and a
 * previously-backfilled day is left alone). `days`: [{ date: "YYYY-MM-DD", tvlUsd }]. Pure. */
export function mergeBackfill(existingPoints, days) {
  const haveDay = new Set(existingPoints.map((p) => dayKey(p.t)));
  const added = [];
  for (const d of days) {
    if (!d?.date || !Number.isFinite(d.tvlUsd) || d.tvlUsd < 0 || haveDay.has(d.date)) continue;
    added.push({ t: d.date, tvlUsd: d.tvlUsd, src: "defillama", ...(d.est ? { est: true } : {}) });
  }
  return { points: sortPoints([...existingPoints, ...added]), added: added.length };
}

/** DefiLlama's daily TVL for the Electroneum chain (= ElectroSwap V2 + V3) -> [{ date, tvlUsd }]. */
export async function fetchDefiLlamaHistory(fetchImpl = fetch) {
  const res = await fetchImpl(DEFILLAMA_CHAIN_TVL_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`DefiLlama returned ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("DefiLlama response wasn't an array");
  return rows
    .map((r) => ({ date: new Date(Number(r.date) * 1000).toISOString().slice(0, 10), tvlUsd: Number(r.tvl) }))
    .filter((r) => Number.isFinite(r.tvlUsd));
}

let writeChain = Promise.resolve(); // serializes read-modify-write so the hourly recorder and the backfill can't clobber each other

/** Records one live measurement (called hourly by tokenLiquidityCache.js). Never throws. */
export function recordTvlPoint({ tvlUsd, valuedPools, totalPools }) {
  const run = async () => {
    try {
      if (!Number.isFinite(tvlUsd) || tvlUsd < 0) return;
      const { points, backfill } = await getTvlHistory();
      const candidate = { t: new Date().toISOString(), tvlUsd: Math.round(tvlUsd * 100) / 100, pools: valuedPools };
      const verdict = assessLivePoint(candidate, points);
      if (!verdict.ok) {
        console.warn(`⚠️  TVL: not recording this run — ${verdict.reason}`);
        return;
      }
      await setTvlHistory(compactPoints([...points, candidate]), backfill);
      console.log(`🔒 TVL recorded — $${Math.round(tvlUsd).toLocaleString()} across ${valuedPools}/${totalPools} pool(s)`);
    } catch (err) {
      console.error("⚠️  TVL history record failed:", err.message);
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/** One-time historical backfill from DefiLlama, run at backend start. Idempotent: once `backfill` is
 * recorded it does nothing, and it only ever fills days that have no point. If DefiLlama is
 * unreachable it simply tries again at the next start; live tracking is unaffected. Never throws. */
export function ensureTvlBackfilled() {
  const run = async () => {
    try {
      const { points, backfill } = await getTvlHistory();
      if (backfill) return;
      const { days, fixed, dropped } = sanitizeDailyTvl(await fetchDefiLlamaHistory());
      const { points: merged, added } = mergeBackfill(points, days);
      await setTvlHistory(compactPoints(merged), { source: "defillama", fetchedAt: new Date().toISOString(), days: added, interpolated: fixed });
      console.log(`🔒 TVL history backfilled from DefiLlama — ${added} daily point(s) added (${fixed} glitch day(s) interpolated${dropped ? `, ${dropped} dropped` : ""})`);
    } catch (err) {
      console.error("⚠️  TVL history backfill failed (will retry next start):", err.message);
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/** Starts TVL history maintenance: the one-time backfill. (Live points are recorded by
 * tokenLiquidityCache.js's hourly pass, which already computes what TVL needs.) No-op without R2. */
export function startTvlHistory() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — TVL history disabled");
    return;
  }
  console.log("🔒 TVL history started (one-time DefiLlama backfill; live points from the hourly liquidity pass)");
  ensureTvlBackfilled();
}
