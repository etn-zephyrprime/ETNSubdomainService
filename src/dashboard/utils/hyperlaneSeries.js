// Pure maths for the Hyperlane Bridge tab — no React or Vite imports, so it can be unit-tested with plain node.
//
// The published file (backend/utils/hyperlaneBridge.js) holds compact transfer events:
//   [timestampSec, tokenIndex, domain, direction (0 = in to Electroneum, 1 = out), amountUsd, block]
// `domain` is Hyperlane's id for the OTHER chain (for the big EVM chains that is the chain id).

const DAY_SEC = 86400;
const DAY_MS = DAY_SEC * 1000;
export const WINDOW_DAYS = 365;

const DIR_IN = 0;

// Hyperlane domain ids of the chains people are likely to bridge from/to. Anything else shows as "Chain <id>".
const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  100: "Gnosis",
  137: "Polygon",
  324: "zkSync",
  5000: "Mantle",
  8453: "Base",
  42161: "Arbitrum",
  42220: "Celo",
  43114: "Avalanche",
  59144: "Linea",
  81457: "Blast",
  534352: "Scroll",
};

export const chainName = (domain) => CHAIN_NAMES[domain] || `Chain ${domain}`;

const dayStartMs = (ms) => Math.floor(ms / DAY_MS) * DAY_MS; // UTC midnight
export const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** First UTC midnight of the rolling window: today and the WINDOW_DAYS - 1 days before it. */
export function windowStartMs(nowMs, days = WINDOW_DAYS) {
  return dayStartMs(nowMs) - (days - 1) * DAY_MS;
}

/** `tokenIndex` null = every token; `domain` null = every chain. */
function matches(e, tokenIndex, domain) {
  return (tokenIndex === null || e[1] === tokenIndex) && (domain === null || e[2] === domain);
}

/** One row per UTC day of the window (zeros filled in, so quiet days still take their place on the axis):
 * `{ t (ms), date, inflow, outflow, net, count }`. Events outside the window are ignored. */
export function dailyFlows(events, { tokenIndex = null, domain = null, nowMs, days = WINDOW_DAYS }) {
  const start = windowStartMs(nowMs, days);
  const rows = Array.from({ length: days }, (_, i) => {
    const t = start + i * DAY_MS;
    return { t, date: dayKeyOf(t), inflow: 0, outflow: 0, net: 0, count: 0 };
  });
  for (const e of events || []) {
    if (!matches(e, tokenIndex, domain)) continue;
    const i = Math.floor((e[0] * 1000 - start) / DAY_MS);
    if (i < 0 || i >= days) continue;
    const amount = e[4];
    if (!Number.isFinite(amount)) continue;
    if (e[3] === DIR_IN) rows[i].inflow += amount;
    else rows[i].outflow += amount;
    rows[i].count += 1;
  }
  for (const r of rows) r.net = r.inflow - r.outflow;
  return rows;
}

/** Sums of a `dailyFlows` result. */
export function totals(rows) {
  let inflow = 0;
  let outflow = 0;
  let count = 0;
  for (const r of rows) { inflow += r.inflow; outflow += r.outflow; count += r.count; }
  return { inflow, outflow, net: inflow - outflow, count };
}

/** All-time net (in - out) of the matching events — for a single token across every chain this equals the
 * token's supply on Electroneum. */
export function netAllTime(events, { tokenIndex = null, domain = null }) {
  let net = 0;
  for (const e of events || []) {
    if (!matches(e, tokenIndex, domain) || !Number.isFinite(e[4])) continue;
    net += e[3] === DIR_IN ? e[4] : -e[4];
  }
  return net;
}

/** Per-chain 12-month breakdown for the selected token(s), biggest total volume first:
 * `[{ domain, name, inflow, outflow, net, count }]`. Includes chains the contracts are enrolled with even if
 * they have no traffic yet (`enrolledDomains`), so they still appear as an option. */
export function chainSummary(events, { tokenIndex = null, nowMs, days = WINDOW_DAYS, enrolledDomains = [] }) {
  const start = windowStartMs(nowMs, days);
  const end = start + days * DAY_MS;
  const byDomain = new Map();
  const ensure = (d) => {
    if (!byDomain.has(d)) byDomain.set(d, { domain: d, name: chainName(d), inflow: 0, outflow: 0, net: 0, count: 0 });
    return byDomain.get(d);
  };
  for (const d of enrolledDomains) ensure(d);
  for (const e of events || []) {
    if (!matches(e, tokenIndex, null) || !Number.isFinite(e[4])) continue;
    const ms = e[0] * 1000;
    if (ms < start || ms >= end) continue;
    const row = ensure(e[2]);
    if (e[3] === DIR_IN) row.inflow += e[4];
    else row.outflow += e[4];
    row.count += 1;
  }
  const rows = [...byDomain.values()];
  for (const r of rows) r.net = r.inflow - r.outflow;
  return rows.sort((a, b) => b.inflow + b.outflow - (a.inflow + a.outflow) || a.domain - b.domain);
}

/** Every chain that has ever moved a matching token (all-time) or is enrolled, ordered by name, for the filter. */
export function chainOptions(events, enrolledDomains = []) {
  const set = new Set(enrolledDomains);
  for (const e of events || []) set.add(e[2]);
  return [...set].sort((a, b) => chainName(a).localeCompare(chainName(b))).map((domain) => ({ domain, name: chainName(domain) }));
}

/** Y-axis range for signed daily bars: always includes 0, with a little headroom. `[min, max]`. */
export function barRange(rows) {
  let lo = 0;
  let hi = 0;
  for (const r of rows) { if (r.net < lo) lo = r.net; if (r.net > hi) hi = r.net; }
  if (lo === 0 && hi === 0) return [-1, 1];
  const pad = (hi - lo) * 0.08;
  return [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0];
}

/** "Nice" y-axis tick values between `lo` and `hi` (which straddle 0): multiples of 1/2/5 x 10^n, always
 * including 0, at most ~5-6 of them. */
export function niceTicks(lo, hi, target = 5) {
  const range = hi - lo;
  if (!(range > 0)) return [0];
  const rough = range / target;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}
