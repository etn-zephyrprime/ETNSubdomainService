// Pure tests for services/argusAlertRules.js. Run from backend/: npm test
import { carryForward } from "../utils/cexBalanceHistory.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenLockAlerts, teamWalletAlerts, validatorAlerts, cexAlerts, cexMoveMessage, bridgeDailyAlert, bridgePacePerDay, hyperlaneFlows, hyperlaneWeeklyAlert, mdToHtml, md } from "../services/argusAlertRules.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const wei = (etn) => (BigInt(Math.round(etn)) * 10n ** 18n).toString();

test("token locks: each stage once per unlock date; first run reports what's already close", () => {
  const locks = { "0xa": { latestUnlockAt: new Date(NOW + 20 * DAY).toISOString(), permanentCount: 0 }, "0xb": { latestUnlockAt: new Date(NOW + 90 * DAY).toISOString(), permanentCount: 0 }, "0xc": { latestUnlockAt: new Date(NOW - 40 * DAY).toISOString(), permanentCount: 1 } };
  let r = tokenLockAlerts(locks, { "0xa": "BOLT" }, {}, NOW);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /BOLT\* — liquidity lock expires in \*30 days\*/);
  assert.doesNotMatch(r.messages[0], /0xc/); // long-expired before watching: quiet
  r = tokenLockAlerts(locks, { "0xa": "BOLT" }, r.state, NOW + DAY); // same stage: nothing new
  assert.equal(r.messages.length, 0);
  r = tokenLockAlerts(locks, { "0xa": "BOLT" }, r.state, NOW + 14 * DAY); // 6 days left
  assert.match(r.messages[0], /7 days/);
  r = tokenLockAlerts(locks, { "0xa": "BOLT" }, r.state, NOW + 19.5 * DAY);
  assert.match(r.messages[0], /1 day/);
  r = tokenLockAlerts(locks, { "0xa": "BOLT" }, r.state, NOW + 20.1 * DAY);
  assert.match(r.messages[0], /expired/);
  const extended = { ...locks, "0xa": { latestUnlockAt: new Date(NOW + 400 * DAY).toISOString(), permanentCount: 0 } };
  r = tokenLockAlerts(extended, { "0xa": "BOLT" }, r.state, NOW + 21 * DAY); // relocked far out: quiet, starts over
  assert.equal(r.messages.length, 0);
});

test("team wallets: first run quiet; new 1M+ movements; combined balance 1%", () => {
  const team = { wallets: [{ balance: wei(100_000_000) }], movements: [{ hash: "0x1", from: "0xteam", to: "0xcex", value: wei(2_000_000), fromIsTeam: true, toIsTeam: false }] };
  let r = teamWalletAlerts(team, {});
  assert.equal(r.messages.length, 0);
  const next = { wallets: [{ balance: wei(100_500_000) }], movements: [{ hash: "0x2", from: "0xa", to: "0xteam", value: wei(1_500_000), fromIsTeam: false, toIsTeam: true }, ...team.movements] };
  r = teamWalletAlerts(next, r.state);
  assert.equal(r.messages.length, 1); // the new IN movement; +0.5% isn't enough
  assert.match(r.messages[0], /IN/);
  r = teamWalletAlerts({ ...next, wallets: [{ balance: wei(98_900_000) }] }, r.state);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /Combined ETN Balance\* 📉 −1\.10%/);
});

test("validators: new outgoing ETN of 100k+ only, flags selling", () => {
  const v = { outgoing: [{ hash: "0xold", symbol: "ETN", value: wei(5), from: "0xv", to: "0xx" }] };
  let r = validatorAlerts(v, {});
  assert.equal(r.messages.length, 0);
  const v2 = { outgoing: [{ hash: "0xbig", symbol: "ETN", value: wei(250_000), from: "0xv1", to: "0xr", destination: { kind: "dex", label: "ElectroSwap (Universal Router)" } }, { hash: "0xsmall", symbol: "ETN", value: wei(50_000), from: "0xv1", to: "0xr" }, ...v.outgoing] };
  r = validatorAlerts(v2, r.state);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /SELLING SIGNAL/);
  assert.equal(validatorAlerts(v2, r.state).messages.length, 0);
});

test("CEX: per exchange, 10M+ against the last alerted balance", () => {
  const b = (k1, k2) => [{ address: "0x1", label: "KuCoin", etn: k1 }, { address: "0x2", label: "KuCoin", etn: k2 }, { address: "0x3", label: "MEXC", etn: 100e6 }];
  let r = cexAlerts(b(900e6, 50e6), {});
  assert.equal(r.messages.length, 0);
  r = cexAlerts(b(895e6, 50e6), r.state); // -5M: no
  assert.equal(r.messages.length, 0);
  r = cexAlerts(b(885e6, 50e6), r.state); // -15M vs the base: yes
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /KuCoin\* 📤 outflow \*−15\.00M ETN/);
  assert.equal(cexAlerts(b(885e6, 50e6), r.state).messages.length, 0); // re-based
  assert.equal(r.moves[0].label, "KuCoin");
  assert.deepEqual(r.moves[0].moved.map((m) => m.address), ["0x1"]);
});

test("CEX: an exchange's address list changing (partial refresh, or an address added) re-bases quietly", () => {
  const full = [{ address: "0x1", label: "KuCoin", etn: 900e6 }, { address: "0x2", label: "KuCoin", etn: 50e6 }];
  let r = cexAlerts(full, {});
  r = cexAlerts(full.slice(0, 1), r.state); // 0x2 missing: looks like −50M, but isn't
  assert.equal(r.messages.length, 0);
  r = cexAlerts(full, r.state); // back again: no false +50M inflow
  assert.equal(r.messages.length, 0);
  // Old state (no address sets saved) re-bases once rather than comparing against a possibly partial base.
  assert.equal(cexAlerts(full, { cexBase: { KuCoin: 10e6 } }).messages.length, 0);
  // And real moves still alert after that.
  assert.equal(cexAlerts([{ ...full[0], etn: 880e6 }, full[1]], r.state).messages.length, 1);
});

test("CEX history: a failed address carries its last published series forward", () => {
  const filled = carryForward([{ date: "2026-10-28", balance: "5" }, { date: "2026-10-29", balance: "7" }], ["2026-10-28", "2026-10-29", "2026-10-30"]);
  assert.deepEqual([...filled.values()], [5n, 7n, 7n]);
});

test("CEX: only 5M+ transfers listed (From / To / explorer link, biggest first), the rest counted, internal ones left out", () => {
  const move = { label: "KuCoin", delta: -15e6, base: 900e6, total: 885e6, addrCount: 2, addresses: ["0x1", "0x2"], moved: [{ address: "0x1", d: -15e6, etn: 885e6 }], sinceMs: 0 };
  const transfers = [
    { hash: "0xsmall", from: "0x1", to: "0xaaa", etn: 2e6 },
    { hash: "0xbig", from: "0x1", to: "0xbbb", etn: 12e6 },
    { hash: "0xmid", from: "0xddd", to: "0x2", etn: 5e6 },
    { hash: "0xinternal", from: "0x1", to: "0x2", etn: 50e6 }, // between KuCoin's own addresses
    { hash: "0xdust", from: "0x1", to: "0xccc", etn: 10 },
  ];
  const m = cexMoveMessage(move, transfers);
  assert.ok(m.includes("*12.00M ETN*\nFrom: @@0x1@@\nTo: @@0xbbb@@\n[View transaction](https://blockexplorer.electroneum.com/tx/0xbig)"));
  assert.ok(m.indexOf("0xbig") < m.indexOf("0xmid"));
  assert.doesNotMatch(m, /0xsmall|0xinternal|0xdust/);
  assert.match(m, /\+2 smaller transfers under 5\.00M$/);
  // Nothing 5M+: says so rather than listing small ones.
  assert.match(cexMoveMessage(move, transfers.slice(0, 1)), /No single transfer of 5\.00M\+ ETN — made up of 1 smaller transfer$/);
  // Lookup failed: falls back to the per-address balance change.
  assert.match(cexMoveMessage(move, null), /@@0x1@@: −15\.00M → 885\.00M/);
});

test("ETN bridge: daily at the hour, 24h change from the previous snapshot, stops after the deadline", () => {
  const bridge = { points: [{ t: "2026-09-29", migratedEtn: 11.9e9 }, { t: "2026-10-28", migratedEtn: 11.97e9 }], current: { migratedEtn: 11.98e9, balanceEtn: 5.98e9, count: 1022994, asOf: "2026-10-29T11:00:00Z" }, top7d: { top: [] } };
  assert.equal(bridgeDailyAlert(bridge, {}, Date.parse("2026-10-29T08:00:00Z"), { hourUtc: 9 }).messages.length, 0); // before the hour
  let r = bridgeDailyAlert(bridge, {}, NOW, { hourUtc: 9 });
  assert.match(r.messages[0], /Remaining in bridge: \*5\.98B ETN\*/);
  assert.match(r.messages[0], /first overview/);
  assert.equal(bridgeDailyAlert(bridge, r.state, NOW + 3600e3).messages.length, 0); // once a day
  const tomorrow = { ...bridge, current: { ...bridge.current, migratedEtn: 11.99e9, balanceEtn: 5.97e9, count: 1023100 } };
  r = bridgeDailyAlert(tomorrow, r.state, NOW + DAY, { hourUtc: 9 });
  assert.match(r.messages[0], /Last 24h: \*10\.00M ETN\* migrated in 106 migrations/);
  assert.ok(bridgePacePerDay(bridge.points, bridge.current) > 0);
  assert.equal(bridgeDailyAlert(bridge, {}, Date.parse("2027-02-05T12:00:00Z")).messages.length, 0);
});

test("Hyperlane: weekly on Monday, 7-day and 12-month flows per chain", () => {
  const s = (d) => Math.floor((NOW - d * DAY) / 1000);
  const events = [[s(2), 1, 8453, 0, 500, 1], [s(3), 0, 1, 1, 200, 2], [s(100), 1, 43114, 0, 1000, 3], [s(400), 1, 1, 0, 9999, 4]];
  const f = hyperlaneFlows(events, s(7));
  assert.deepEqual(f, { 8453: { in: 500, out: 0 }, 1: { in: 0, out: 200 } });
  const monday = Date.parse("2026-11-02T10:00:00Z");
  assert.equal(hyperlaneWeeklyAlert({ events }, {}, Date.parse("2026-11-01T10:00:00Z")).messages.length, 0); // Sunday
  const r = hyperlaneWeeklyAlert({ events: events.map((e) => [e[0] + 4 * 86400, ...e.slice(1)]) }, {}, monday);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /Last 12 months:\* net \+\$1,300/); // 9,999 is older than a year
  assert.equal(hyperlaneWeeklyAlert({ events }, r.state, monday + 3600e3).messages.length, 0);
});

test("Markdown to HTML keeps names literal", () => {
  assert.equal(mdToHtml(`*${md("a_b*c")}* [x](https://e.x/y) <&>`), '<b>a_b*c</b> <a href="https://e.x/y">x</a> &lt;&amp;&gt;');
});
