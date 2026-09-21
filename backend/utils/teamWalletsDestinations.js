// backend/utils/teamWalletsDestinations.js
//
// "Where did the team's ETN go?" — for the Team Wallets tab. Over a rolling 12 months, totals what the suspected
// team wallets sent OUT to addresses outside the team (and what came back IN), ranks the destinations by net ETN
// received, labels them (known exchange from this backend's cex_addresses table, contract name, ENS), and follows
// the money one hop further for destination wallets: where did THEY send it, and how much do they still hold?
//
// Everything comes from the explorer's per-address transaction lists (native ETN transfers), walked back to the
// 12-month cutoff — the whole team's activity is a few thousand transactions, so a full re-walk every few hours is
// cheap and needs no incremental cursor logic (same reasoning as teamWalletsBalanceHistory.js).
//
// HONEST LIMITS, also stated in the UI: the second hop counts EVERYTHING a destination wallet sent on after it
// first received team ETN (it may have mixed in other people's ETN), and "fate" totals spread a destination's
// forwarded amount across its onward recipients pro rata — so they are a good picture of where the money went, not
// an accounting identity. Only plain native transfers are followed (not swaps/bridges out of the ETN coin).
import { TEAM_WALLET_ADDRESSES } from "./teamWalletsCache.js";
import { listCexAddresses } from "../db/cexAddresses.js";
import { getTeamWalletDestinationsCache, setTeamWalletDestinationsCache } from "../state/teamWalletDestinationsState.js";

const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const CACHE_INTERVAL_MS = process.env.TEAM_WALLET_DESTINATIONS_INTERVAL_MS
  ? parseInt(process.env.TEAM_WALLET_DESTINATIONS_INTERVAL_MS, 10)
  : 6 * 60 * 60 * 1000;
const WINDOW_DAYS = 365;
const MAX_PAGES_PER_WALLET = 60; // safety net, not an expected limit
const MAX_DESTINATIONS = 15;
const MIN_DESTINATION_NET_WEI = 1_000_000n * 10n ** 18n; // only destinations that received >= 1M ETN net from the team
const ONWARD_SHOWN = 3;
const CONCURRENCY = 4;

const TEAM_SET = new Set(TEAM_WALLET_ADDRESSES.map((a) => a.toLowerCase()));
const lc = (a) => (a || "").toLowerCase();
const ZERO = 0n;

async function fetchJson(path, fetchImpl = fetch) {
  const res = await fetchImpl(`${EXPLORER_BASE_URL}/api/v2${path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`explorer ${path} returned ${res.status}`);
  return res.json();
}

/** Every successful native-ETN transaction of `address` in the given direction (`from` = sent by it, `to` =
 * received by it) since `cutoffMs`, newest first, following pagination. `[{ from, to, value (BigInt wei), ts (ms) }]`. */
export async function walkTransfers(address, direction, cutoffMs, fetchImpl = fetch) {
  const out = [];
  let params = "";
  for (let page = 0; page < MAX_PAGES_PER_WALLET; page++) {
    const res = await fetchJson(`/addresses/${address}/transactions?filter=${direction}${params}`, fetchImpl);
    let sawOld = false;
    for (const tx of res.items || []) {
      const ts = Date.parse(tx.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoffMs) { sawOld = true; continue; }
      let value;
      try { value = BigInt(tx.value || "0"); } catch { continue; }
      if (value <= ZERO || (tx.status && tx.status !== "ok")) continue;
      out.push({ from: lc(tx.from?.hash), to: lc(tx.to?.hash), value, ts });
    }
    if (sawOld || !res.next_page_params) break;
    params = `&${new URLSearchParams(res.next_page_params).toString()}`;
  }
  return out;
}

/** Aggregates the team's outgoing and incoming transfers per outside counterparty. Pure. Exported for tests.
 * `outgoing`/`incoming` are `walkTransfers` results (any mix of team wallets). Returns a Map
 * address -> { out, in, outCount, firstOutTs, lastOutTs } (wei as BigInt). Transfers between two team wallets are ignored. */
export function aggregateCounterparties(outgoing, incoming, teamSet = TEAM_SET) {
  const map = new Map();
  const get = (a) => {
    if (!map.has(a)) map.set(a, { out: ZERO, in: ZERO, outCount: 0, firstOutTs: Infinity, lastOutTs: 0 });
    return map.get(a);
  };
  for (const t of outgoing) {
    if (!t.to || teamSet.has(t.to) || !teamSet.has(t.from)) continue;
    const c = get(t.to);
    c.out += t.value;
    c.outCount += 1;
    c.firstOutTs = Math.min(c.firstOutTs, t.ts);
    c.lastOutTs = Math.max(c.lastOutTs, t.ts);
  }
  for (const t of incoming) {
    if (!t.from || teamSet.has(t.from) || !teamSet.has(t.to)) continue;
    get(t.from).in += t.value;
  }
  return map;
}

/** The biggest net recipients: those whose (out - in) is at least `minNetWei`, largest first. Pure. */
export function rankDestinations(counterparties, minNetWei = MIN_DESTINATION_NET_WEI, limit = MAX_DESTINATIONS) {
  return [...counterparties.entries()]
    .map(([address, c]) => ({ address, ...c, net: c.out - c.in }))
    .filter((d) => d.net >= minNetWei)
    .sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
    .slice(0, limit);
}

/** Spreads the ETN a destination wallet no longer holds across where it went next, pro rata to what it sent to each
 * onward recipient. `held` is capped at `net`. Returns `{ held, sentOn: Map<address, wei>, unaccounted }`. Pure. */
export function attributeFate(net, balance, onwardByRecipient) {
  const held = balance < net ? balance : net;
  const remainder = net - held;
  const total = [...onwardByRecipient.values()].reduce((s, v) => s + v, ZERO);
  const sentOn = new Map();
  if (remainder > ZERO && total > ZERO) {
    for (const [addr, amount] of onwardByRecipient) sentOn.set(addr, (remainder * amount) / total);
  }
  const attributed = [...sentOn.values()].reduce((s, v) => s + v, ZERO);
  return { held, sentOn, unaccounted: remainder - attributed };
}

const ETN = 10n ** 18n;
const toEtn = (wei) => Number(wei / (ETN / 1000n)) / 1000; // ETN with 3 decimals, safe for display

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

let isRunning = false;

/** Builds the destinations report. Dependencies injectable for tests. */
export async function buildDestinationsReport({ fetchImpl = fetch, cexLabels = new Map(), now = Date.now() } = {}) {
  const cutoffMs = now - WINDOW_DAYS * 86400000;

  const perWallet = await mapLimit(TEAM_WALLET_ADDRESSES, CONCURRENCY, async (address) => {
    const [outgoing, incoming] = await Promise.all([walkTransfers(address, "from", cutoffMs, fetchImpl), walkTransfers(address, "to", cutoffMs, fetchImpl)]);
    return { outgoing, incoming };
  });
  const outgoing = perWallet.flatMap((w) => w.outgoing);
  const incoming = perWallet.flatMap((w) => w.incoming);

  const counterparties = aggregateCounterparties(outgoing, incoming);
  let totalOut = ZERO;
  let totalIn = ZERO;
  for (const c of counterparties.values()) { totalOut += c.out; totalIn += c.in; }
  const ranked = rankDestinations(counterparties);

  const infoCache = new Map();
  const describe = async (address) => {
    if (infoCache.has(address)) return infoCache.get(address);
    const promise = (async () => {
      const cexLabel = cexLabels.get(address);
      let info = {};
      try { info = await fetchJson(`/addresses/${address}`, fetchImpl); } catch { /* label falls back to the address */ }
      const isContract = Boolean(info.is_contract);
      const name = info.name || info.ens_domain_name || null;
      let balance = ZERO;
      try { balance = BigInt(info.coin_balance || "0"); } catch { /* keep 0 */ }
      return { address, kind: cexLabel ? "exchange" : isContract ? "contract" : "wallet", label: cexLabel || name || null, balance };
    })();
    infoCache.set(address, promise);
    return promise;
  };

  const destinations = await mapLimit(ranked, 3, async (d) => {
    const meta = await describe(d.address);
    const row = { address: d.address, kind: meta.kind, label: meta.label, netOut: toEtn(d.net), out: toEtn(d.out), in: toEtn(d.in), transfers: d.outCount, firstOut: new Date(d.firstOutTs).toISOString(), lastOut: new Date(d.lastOutTs).toISOString(), balance: toEtn(meta.balance), onward: [], heldEtn: 0, exchangeEtn: 0, otherEtn: 0 };

    if (meta.kind === "wallet") {
      // one hop further: where did this wallet send ETN after first receiving from the team?
      const onwardTransfers = (await walkTransfers(d.address, "from", Math.max(cutoffMs, d.firstOutTs), fetchImpl)).filter((t) => t.to !== d.address && !TEAM_SET.has(t.to));
      const byRecipient = new Map();
      for (const t of onwardTransfers) byRecipient.set(t.to, (byRecipient.get(t.to) || ZERO) + t.value);
      const fate = attributeFate(d.net, meta.balance, byRecipient);
      row.heldEtn = toEtn(fate.held);

      const rankedOnward = [...byRecipient.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
      const described = await mapLimit(rankedOnward.slice(0, ONWARD_SHOWN), 3, async ([addr, amount]) => ({ ...(await describe(addr)), amount }));
      row.onward = described.map((o) => ({ address: o.address, kind: o.kind, label: o.label, amount: toEtn(o.amount), balance: toEtn(o.balance) }));
      // Fate split: exchange vs other, using every onward recipient (not just the ones shown).
      let exchange = ZERO;
      let other = fate.unaccounted;
      for (const [addr, share] of fate.sentOn) {
        const o = await describe(addr);
        if (o.kind === "exchange") exchange += share; else other += share;
      }
      row.exchangeEtn = toEtn(exchange);
      row.otherEtn = toEtn(other);
    } else if (meta.kind === "exchange") {
      row.exchangeEtn = row.netOut;
    } else {
      row.otherEtn = row.netOut; // contract: the ETN went into it (NFT purchase, staking, ...)
    }
    return row;
  });

  const sum = (f) => destinations.reduce((s, d) => s + d[f], 0);
  const tracedNet = destinations.reduce((s, d) => s + d.netOut, 0);
  return {
    windowDays: WINDOW_DAYS,
    generatedAt: new Date(now).toISOString(),
    totals: { outEtn: toEtn(totalOut), inEtn: toEtn(totalIn), netOutEtn: toEtn(totalOut - totalIn), destinationsNetEtn: tracedNet },
    fate: { exchangeEtn: sum("exchangeEtn"), heldEtn: sum("heldEtn"), otherEtn: sum("otherEtn") },
    destinations,
  };
}

async function refreshAndPublish() {
  if (isRunning) return;
  isRunning = true;
  try {
    const cexLabels = new Map();
    try {
      for (const row of await listCexAddresses()) cexLabels.set(lc(row.address), row.label);
    } catch (err) {
      console.warn("⚠️  Team wallet destinations: couldn't load CEX labels:", err.message);
    }
    const report = await buildDestinationsReport({ cexLabels });
    await setTeamWalletDestinationsCache(report);
    console.log(`🧭 Team wallet destinations updated — ${report.destinations.length} destination(s), net out ${Math.round(report.totals.netOutEtn).toLocaleString()} ETN`);
  } catch (err) {
    console.error("⚠️  Team wallet destinations refresh failed (keeping the previous report):", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the report refresher: once now, then every few hours. No-op without R2. */
export function startTeamWalletDestinations() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — team wallet destinations disabled");
    return;
  }
  console.log(`🧭 Team wallet destinations started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}

export { getTeamWalletDestinationsCache };
