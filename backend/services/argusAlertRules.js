// backend/services/argusAlertRules.js
//
// Pure rules behind the owner's Argus Telegram alerts (utils/argusAlertsScheduler.js posts them to
// the Planet Zephyros group — same bot and topic as the CORE buy/sell/burn alerts). Each rule takes the data Argus already publishes plus the
// alert state from last time, and returns { messages: [markdown text], state } — no I/O, so every
// rule is unit-tested (tests/argusAlertRules.test.js).
//
// A rule's FIRST run records what's already there without alerting (so turning this on doesn't
// replay months of history) — except token locks, where anything already inside 30 days is worth
// one message.

const DAY_MS = 86400000;
const WEI = 10n ** 18n;

/** Escapes Telegram (legacy) Markdown in dynamic text: symbols, labels and names can contain _ * ` [. */
export const md = (s) => String(s ?? "").replace(/([_*`\[])/g, "\\$1");

/** The rules write light Markdown (*bold*, [text](url), md()-escaped dynamic text); the Zephyros
 * group bot posts HTML (same as the CORE buy/sell/burn alerts), so this converts at send time. */
export function mdToHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(?<!\\)\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(?<!\\)\*(.+?)(?<!\\)\*/g, "<b>$1</b>")
    .replace(/\\([_*`\[])/g, "$1");
}
export const fmtEtn = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};
const signed = (n, f = fmtEtn) => `${n >= 0 ? "+" : "−"}${f(Math.abs(n))}`;
const usd = (n) => `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const signedUsd = (n) => `${n >= 0 ? "+" : "−"}${usd(n)}`;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
// A WALLET address in a message: the scheduler swaps each marker for the wallet's ENS name (or the
// shortened address when it has none) just before sending — see resolveWalletNames there.
export const walletRef = (a) => (a ? `@@${a.toLowerCase()}@@` : "?");
export const WALLET_REF_RE = /@@(0x[0-9a-f]{40})@@/g;
const weiToEtn = (w) => {
  try {
    const b = BigInt(w || "0");
    return Number(b / WEI) + Number(b % WEI) / 1e18;
  } catch {
    return 0;
  }
};
const remember = (list, items, max = 1000) => [...(list || []), ...items].slice(-max);

// ---- 1. Token lock expiry -----------------------------------------------------------------------

const LOCK_STAGES = ["30d", "7d", "1d", "expired"]; // in order of urgency
const lockStage = (msLeft) => (msLeft <= 0 ? "expired" : msLeft <= DAY_MS ? "1d" : msLeft <= 7 * DAY_MS ? "7d" : msLeft <= 30 * DAY_MS ? "30d" : null);
const rank = (stage) => (stage ? LOCK_STAGES.indexOf(stage) : -1);

/**
 * Warns when a token's LAST liquidity lock (token-locks.json's latestUnlockAt — when its locked
 * liquidity becomes withdrawable) is 30 days, 7 days and 1 day away, and when it has expired. Each
 * stage once per unlock date; a lock that's extended to a later date starts over. Already expired by
 * more than a day when first seen: recorded quietly (old news).
 * @param symbols { [address]: symbol }
 */
export function tokenLockAlerts(locksByAddress, symbols, state = {}, nowMs = Date.now()) {
  const locks = { ...(state.locks || {}) };
  const lines = [];
  for (const [addr, info] of Object.entries(locksByAddress || {})) {
    if (!info?.latestUnlockAt) continue;
    const unlockMs = Date.parse(info.latestUnlockAt);
    if (!Number.isFinite(unlockMs)) continue;
    const prev = locks[addr];
    const known = prev && prev.unlockAt === info.latestUnlockAt ? prev : null; // a new date starts over
    const stage = lockStage(unlockMs - nowMs);
    if (!known && stage === "expired" && nowMs - unlockMs > DAY_MS) {
      locks[addr] = { unlockAt: info.latestUnlockAt, stage }; // long expired before we started watching
      continue;
    }
    if (rank(stage) > rank(known?.stage)) {
      const sym = md(symbols?.[addr] || short(addr));
      const when = new Date(unlockMs).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const perm = info.permanentCount > 0 ? ` (${info.permanentCount} permanent lock${info.permanentCount === 1 ? "" : "s"} stay)` : "";
      lines.push(
        stage === "expired"
          ? `🔓 *${sym}* — liquidity lock *expired* ${when}: the locked LP can now be withdrawn${perm}`
          : `⏳ *${sym}* — liquidity lock expires in *${stage === "1d" ? "1 day" : stage === "7d" ? "7 days" : "30 days"}* (${when})${perm}`
      );
    }
    locks[addr] = { unlockAt: info.latestUnlockAt, stage: rank(stage) > rank(known?.stage) ? stage : known?.stage ?? stage };
  }
  const messages = lines.length ? [`🔒 *Token lock expiry*\n\n${lines.join("\n")}`] : [];
  return { messages, state: { ...state, locks } };
}

// ---- 2. Team wallets ----------------------------------------------------------------------------

/**
 * New team-wallet movements of at least `minEtn` (team-wallets.json movements: OUT / IN / INTERNAL),
 * and the combined balance moving by `pct`% or more since the last alert (then that's the new base).
 */
export function teamWalletAlerts(team, state = {}, { minEtn = 1_000_000, pct = 1 } = {}) {
  const messages = [];
  const movements = team?.movements || [];
  const seen = new Set(state.teamSeen || []);
  const fresh = movements.filter((m) => m?.hash && !seen.has(m.hash));
  if (state.teamInit) {
    for (const m of fresh.reverse()) {
      const etn = weiToEtn(m.value);
      if (etn < minEtn) continue;
      const kind = m.fromIsTeam && !m.toIsTeam ? "🔴 OUT" : !m.fromIsTeam && m.toIsTeam ? "🟢 IN" : "🔵 INTERNAL";
      messages.push(`👥 *Team wallet movement* — ${kind}\n\n*${fmtEtn(etn)} ETN* ${walletRef(m.from)}${m.fromIsTeam ? " (team)" : ""} → ${walletRef(m.to)}${m.toIsTeam ? " (team)" : ""}\n[View transaction](https://blockexplorer.electroneum.com/tx/${m.hash})`);
    }
  }
  const next = { ...state, teamInit: true, teamSeen: remember(state.teamSeen, fresh.map((m) => m.hash), 500) };

  const total = (team?.wallets || []).reduce((s, w) => s + weiToEtn(w.balance), 0);
  if (total > 0) {
    const base = state.teamBase;
    if (!(base > 0)) next.teamBase = total;
    else if (Math.abs(total / base - 1) * 100 >= pct) {
      messages.push(`👥 *Team Combined ETN Balance* ${total >= base ? "📈" : "📉"} ${signed(((total / base - 1) * 100), (x) => x.toFixed(2) + "%")}\n\n${fmtEtn(base)} → *${fmtEtn(total)} ETN* (${signed(total - base)} ETN)`);
      next.teamBase = total;
    }
  }
  return { messages, state: next };
}

// ---- 3. Validators ------------------------------------------------------------------------------

/** New outgoing validator transfers of at least `minEtn` ETN (validator-wallets.json outgoing). */
export function validatorAlerts(validators, state = {}, { minEtn = 100_000 } = {}) {
  const messages = [];
  const outgoing = validators?.outgoing || [];
  const key = (o) => `${o.hash}:${o.symbol}`;
  const seen = new Set(state.valSeen || []);
  const fresh = outgoing.filter((o) => o?.hash && !seen.has(key(o)));
  if (state.valInit) {
    for (const o of fresh.reverse()) {
      if (o.symbol !== "ETN" || o.failed) continue;
      const etn = weiToEtn(o.value);
      if (etn < minEtn) continue;
      const kind = o.destination?.kind;
      const tag = kind === "dex" || kind === "cex" ? "🔴 SELLING SIGNAL" : kind === "team" || kind === "validator" ? "🔵 within the team" : "🟠 outgoing";
      messages.push(`🛡️ *Validator moved ETN* — ${tag}\n\n*${fmtEtn(etn)} ETN* from validator ${walletRef(o.from)} → ${o.destination?.label ? md(o.destination.label) : walletRef(o.to)}\n[View transaction](https://blockexplorer.electroneum.com/tx/${o.hash})`);
    }
  }
  return { messages, state: { ...state, valInit: true, valSeen: remember(state.valSeen, fresh.map(key), 500) } };
}

// ---- 4. CEX balances ----------------------------------------------------------------------------

const TX_URL = (hash) => `https://blockexplorer.electroneum.com/tx/${hash}`;
const CEX_MAX_TRANSFERS = 5;
const CEX_MAJOR_TRANSFER_ETN = 5_000_000; // only transfers this big are listed; smaller ones are counted

/**
 * An exchange's combined balance (all its addresses, grouped by label) moving by `minEtn` or more
 * since the last alert for it (then that's its new base). `balances`: [{ address, label, etn }].
 * Also returns `moves`: the scheduler looks up the transfers behind each one and rebuilds its
 * message with them (cexMoveMessage) — `messages` here is the version without transfers.
 */
export function cexAlerts(balances, state = {}, { minEtn = 10_000_000, nowMs = Date.now() } = {}) {
  const moves = [];
  const byLabel = new Map();
  for (const b of balances || []) {
    const g = byLabel.get(b.label) || { total: 0, addrs: [] };
    g.total += b.etn;
    g.addrs.push(b);
    byLabel.set(b.label, g);
  }
  const cexBase = { ...(state.cexBase || {}) };
  const cexAddrBase = { ...(state.cexAddrBase || {}) };
  // When each exchange's base was set — the start of the window its transfers are looked up over.
  const cexBaseAt = { ...(state.cexBaseAt || {}) };
  const nowIso = new Date(nowMs).toISOString();
  for (const [label, g] of byLabel) {
    const base = cexBase[label];
    if (base == null) {
      cexBase[label] = g.total;
      cexBaseAt[label] = nowIso;
      for (const a of g.addrs) cexAddrBase[a.address] = a.etn;
      continue;
    }
    const delta = g.total - base;
    if (Math.abs(delta) >= minEtn) {
      const moved = g.addrs
        .map((a) => ({ address: a.address, etn: a.etn, d: a.etn - (cexAddrBase[a.address] ?? a.etn) }))
        .filter((x) => Math.abs(x.d) >= 1)
        .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
      const sinceMs = Date.parse(cexBaseAt[label] || "") || nowMs - 7 * DAY_MS;
      moves.push({ label, delta, base, total: g.total, addrCount: g.addrs.length, addresses: g.addrs.map((a) => a.address), moved, sinceMs });
      cexBase[label] = g.total;
      cexBaseAt[label] = nowIso;
      for (const a of g.addrs) cexAddrBase[a.address] = a.etn;
    }
  }
  return { messages: moves.map((m) => cexMoveMessage(m)), moves, state: { ...state, cexBase, cexAddrBase, cexBaseAt } };
}

/**
 * One exchange move as a message. `transfers` ([{ hash, from, to, etn }] — native ETN in or out of
 * the exchange's addresses over the move's window) lists the major ones (5M+), each with From / To
 * and a block-explorer link, and counts the rest. Wallets are walletRef markers: the scheduler
 * shows an exchange address as that exchange's tag, anything else as its ENS name (or short
 * address). If the lookup failed (`transfers` null) it falls back to each address's balance change.
 */
export function cexMoveMessage(move, transfers = null) {
  const head = `🏦 *${md(move.label)}* ${move.delta >= 0 ? "📥 inflow" : "📤 outflow"} *${signed(move.delta)} ETN*\n\n${fmtEtn(move.base)} → *${fmtEtn(move.total)} ETN* across ${move.addrCount} address${move.addrCount === 1 ? "" : "es"}`;
  const own = new Set((move.addresses || move.moved.map((m) => m.address)).map((a) => a.toLowerCase()));
  const internal = (t) => own.has(t.from.toLowerCase()) && own.has(t.to.toLowerCase()); // between its own addresses
  if (!transfers) {
    const lines = move.moved.slice(0, 5).map((x) => `  ${walletRef(x.address)}: ${signed(x.d)} → ${fmtEtn(x.etn)}`);
    return lines.length ? `${head}\n${lines.join("\n")}` : head;
  }
  const external = transfers.filter((t) => t.etn > 0 && !internal(t));
  const major = external.filter((t) => t.etn >= CEX_MAJOR_TRANSFER_ETN).sort((a, b) => b.etn - a.etn);
  const smaller = external.length - major.length;
  const plural = (n) => `${n} smaller transfer${n === 1 ? "" : "s"}`;
  if (major.length === 0) {
    return `${head}\n\nNo single transfer of ${fmtEtn(CEX_MAJOR_TRANSFER_ETN)}+ ETN${smaller > 0 ? ` — made up of ${plural(smaller)}` : ""}`;
  }
  const shown = major
    .slice(0, CEX_MAX_TRANSFERS)
    .map((t) => `*${fmtEtn(t.etn)} ETN*\nFrom: ${walletRef(t.from)}\nTo: ${walletRef(t.to)}\n[View transaction](${TX_URL(t.hash)})`);
  const extra = [];
  if (major.length > shown.length) extra.push(`+${major.length - shown.length} more of ${fmtEtn(CEX_MAJOR_TRANSFER_ETN)}+`);
  if (smaller > 0) extra.push(`+${plural(smaller)} under ${fmtEtn(CEX_MAJOR_TRANSFER_ETN)}`);
  return `${head}\n\n${shown.join("\n\n")}${extra.length ? `\n\n${extra.join(" · ")}` : ""}`;
}

// ---- 5. ETN Bridge daily ------------------------------------------------------------------------

export const BRIDGE_DEADLINE_MS = Date.parse("2027-01-31T23:59:59Z"); // same as src/dashboard/utils/bridgeSeries.js
const pointTime = (t) => (String(t).length <= 10 ? Date.parse(`${t}T23:59:59Z`) : Date.parse(t));

/** Trailing `windowDays` migration pace (ETN/day) from cumulative points — same maths as the tab. */
export function bridgePacePerDay(points, current, windowDays = 30) {
  const rows = (points || []).map((p) => ({ t: pointTime(p.t), m: p.migratedEtn })).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.m));
  if (current?.asOf && Number.isFinite(current.migratedEtn)) rows.push({ t: Date.parse(current.asOf), m: current.migratedEtn });
  rows.sort((a, b) => a.t - b.t);
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  let base = rows[0];
  for (const r of rows) if (r.t <= last.t - windowDays * DAY_MS) base = r;
  const days = (last.t - base.t) / DAY_MS;
  return days >= 1 ? Math.max(0, (last.m - base.m) / days) : null;
}

/**
 * Once a day (at or after `hourUtc`) until the deadline: remaining in the bridge, migrated, time
 * left, current pace, pace needed, forecast at the deadline, and migrations in the last 24 hours
 * (against yesterday's snapshot, plus the largest ones from the published top list).
 */
export function bridgeDailyAlert(bridge, state = {}, nowMs = Date.now(), { hourUtc = 9 } = {}) {
  const cur = bridge?.current;
  if (!cur || !Number.isFinite(cur.migratedEtn) || !Number.isFinite(cur.balanceEtn)) return { messages: [], state };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (nowMs > BRIDGE_DEADLINE_MS + DAY_MS || state.bridgeLastDay === today || new Date(nowMs).getUTCHours() < hourUtc) return { messages: [], state };

  const total = cur.migratedEtn + cur.balanceEtn;
  const daysLeft = Math.max(0, (BRIDGE_DEADLINE_MS - nowMs) / DAY_MS);
  const pace = bridgePacePerDay(bridge.points, cur);
  const needed = daysLeft > 0 ? cur.balanceEtn / daysLeft : null;
  const forecast = pace == null ? null : Math.max(0, cur.balanceEtn - pace * daysLeft);
  const snap = state.bridgeSnap;
  const last24 = snap && nowMs - Date.parse(snap.at) < 2 * DAY_MS ? { etn: cur.migratedEtn - snap.migrated, count: cur.count - snap.count } : null;
  const recentTop = (bridge.top7d?.top || []).filter((t) => t.timestamp && nowMs - Date.parse(t.timestamp) <= DAY_MS).slice(0, 5);

  const lines = [
    `🌉 *ETN Bridge — daily overview*`,
    ``,
    `Remaining in bridge: *${fmtEtn(cur.balanceEtn)} ETN* (${((cur.balanceEtn / total) * 100).toFixed(1)}%)`,
    `Migrated: *${fmtEtn(cur.migratedEtn)} ETN* (${((cur.migratedEtn / total) * 100).toFixed(1)}%, ${cur.count.toLocaleString("en-US")} migrations)`,
    `Time left: *${Math.ceil(daysLeft)} days* (deadline 31 Jan 2027)`,
    `Current pace: *${pace == null ? "—" : fmtEtn(pace)} ETN/day* (30-day average)`,
    `Pace needed: *${needed == null ? "—" : fmtEtn(needed)} ETN/day*${pace > 0 && needed ? ` (${(needed / pace).toFixed(0)}× current)` : ""}`,
    `Forecast at deadline: *${forecast == null ? "—" : forecast === 0 ? "fully migrated" : `${fmtEtn(forecast)} ETN still in the bridge`}*`,
    ``,
    last24
      ? `Last 24h: *${fmtEtn(last24.etn)} ETN* migrated in ${last24.count.toLocaleString("en-US")} migration${last24.count === 1 ? "" : "s"}`
      : `Last 24h: first overview — tomorrow's will show the 24h change`,
    ...recentTop.map((t) => `  • ${fmtEtn(t.etn)} ETN → ${walletRef(t.to)}`),
  ];
  return {
    messages: [lines.join("\n")],
    state: { ...state, bridgeLastDay: today, bridgeSnap: { at: new Date(nowMs).toISOString(), migrated: cur.migratedEtn, count: cur.count } },
  };
}

// ---- 6. Hyperlane weekly ------------------------------------------------------------------------

const CHAIN_NAMES = { 1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 137: "Polygon", 8453: "Base", 42161: "Arbitrum", 43114: "Avalanche" }; // as hyperlaneSeries.js
const chainName = (d) => CHAIN_NAMES[d] || `Chain ${d}`;

/** In / out / net per chain over events newer than sinceSec: { [domain]: { in, out } }. */
export function hyperlaneFlows(events, sinceSec) {
  const by = {};
  for (const e of events || []) {
    const [ts, , domain, dir, amount] = e;
    if (ts < sinceSec || !Number.isFinite(amount)) continue;
    const r = (by[domain] = by[domain] || { in: 0, out: 0 });
    if (dir === 0) r.in += amount;
    else r.out += amount;
  }
  return by;
}

/**
 * Once a week (on `weekday`, 0 = Sunday, at or after `hourUtc`): net flow per chain over the last 7
 * days, and inflow / outflow / net per chain over the last 12 months (USDT + USDC, in dollars).
 */
export function hyperlaneWeeklyAlert(hyperlane, state = {}, nowMs = Date.now(), { weekday = 1, hourUtc = 9 } = {}) {
  const now = new Date(nowMs);
  const weekKey = new Date(nowMs - ((now.getUTCDay() - weekday + 7) % 7) * DAY_MS).toISOString().slice(0, 10);
  if (now.getUTCDay() !== weekday || now.getUTCHours() < hourUtc || state.hyperLastWeek === weekKey) return { messages: [], state };
  const events = hyperlane?.events || [];
  const nowSec = Math.floor(nowMs / 1000);
  const week = hyperlaneFlows(events, nowSec - 7 * 86400);
  const year = hyperlaneFlows(events, nowSec - 365 * 86400);
  const sum = (by) => Object.values(by).reduce((s, r) => ({ in: s.in + r.in, out: s.out + r.out }), { in: 0, out: 0 });
  const domains = [...new Set([...Object.keys(year), ...Object.keys(week)])].sort((a, b) => (year[b]?.in || 0) + (year[b]?.out || 0) - ((year[a]?.in || 0) + (year[a]?.out || 0)));
  const w = sum(week), y = sum(year);
  const lines = [
    `🌐 *Hyperlane Bridge — weekly* (USDT + USDC)`,
    ``,
    `*Last 7 days — net flow:* ${signedUsd(w.in - w.out)} (in ${usd(w.in)} / out ${usd(w.out)})`,
    ...domains.map((d) => `  ${md(chainName(d))}: ${signedUsd((week[d]?.in || 0) - (week[d]?.out || 0))}`),
    ``,
    `*Last 12 months:* net ${signedUsd(y.in - y.out)} (in ${usd(y.in)} / out ${usd(y.out)})`,
    ...domains.map((d) => `  ${md(chainName(d))}: in ${usd(year[d]?.in || 0)} / out ${usd(year[d]?.out || 0)} / net ${signedUsd((year[d]?.in || 0) - (year[d]?.out || 0))}`),
  ];
  return { messages: [lines.join("\n")], state: { ...state, hyperLastWeek: weekKey } };
}
