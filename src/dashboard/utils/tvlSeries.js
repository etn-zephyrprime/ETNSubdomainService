// Pure helpers turning the raw TVL history points (see hooks/useTvlHistory.js and backend
// tvlHistory.js) into what the Overview tab shows. Kept free of any Vite/React imports so they can be
// tested directly.
//
// Points are `{ t, tvlUsd, pools?, src?, est? }`: `t` is a full ISO timestamp for the hourly live
// points and "YYYY-MM-DD" for daily ones.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (t) => String(t).slice(0, 10);
const timeOf = (t) => (String(t).length <= 10 ? Date.parse(`${t}T00:00:00Z`) : Date.parse(t));
const valid = (points) => (points || []).filter((p) => Number.isFinite(p?.tvlUsd) && Number.isFinite(timeOf(p.t))).sort((a, b) => timeOf(a.t) - timeOf(b.t));

/** One point per UTC day, as `{ label: "YYYY-MM-DD", value }` for the chart. The last point of each day
 * wins (so today shows the latest hourly reading). Days with no point at all — the tracker was down, or a
 * source dropped a day — are filled by carrying the previous value forward: the chart places points by
 * INDEX, so a missing day would otherwise silently compress the time axis and make everything after it
 * look closer in time than it is. Also why hourly points aren't charted directly (a couple of weeks of
 * hourly points would take as much width as two years of daily ones). */
export function toDailyTvlSeries(points) {
  const sorted = valid(points);
  if (sorted.length === 0) return [];
  const lastOfDay = new Map();
  for (const p of sorted) lastOfDay.set(dayOf(p.t), p.tvlUsd); // ascending, so the last write per day is that day's latest

  const first = Date.parse(`${dayOf(sorted[0].t)}T00:00:00Z`);
  const last = Date.parse(`${dayOf(sorted[sorted.length - 1].t)}T00:00:00Z`);
  const out = [];
  let prev = null;
  for (let ms = first; ms <= last; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const v = lastOfDay.has(day) ? lastOfDay.get(day) : prev;
    out.push({ label: day, value: v });
    prev = v;
  }
  return out;
}

/** Headline figures from the raw points: the latest value, its change over ~24h, and the day this
 * dashboard's own live tracking began (everything before is the DefiLlama backfill). Null fields where
 * there isn't enough data to say. The 24h reference must be genuinely about a day back (within 6h of it)
 * so a thin history can't produce a misleading "24h" change. */
export function summarizeTvl(points) {
  const sorted = valid(points);
  if (sorted.length === 0) return { latest: null, change24hPct: null, liveSinceDay: null };

  const latest = sorted[sorted.length - 1];
  const target = timeOf(latest.t) - DAY_MS;
  let best = null;
  for (const p of sorted) {
    if (p === latest) continue;
    const gap = Math.abs(timeOf(p.t) - target);
    if (gap <= 6 * 3600e3 && (best == null || gap < Math.abs(timeOf(best.t) - target))) best = p;
  }
  const change24hPct = best && best.tvlUsd > 0 ? ((latest.tvlUsd - best.tvlUsd) / best.tvlUsd) * 100 : null;

  const firstLive = sorted.find((p) => p.src !== "defillama");
  return { latest: latest.tvlUsd, change24hPct, liveSinceDay: firstLive ? dayOf(firstLive.t) : null };
}
