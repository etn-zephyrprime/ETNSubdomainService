// Pure tests for services/argusAlertRules.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenLockAlerts, teamWalletAlerts, validatorAlerts, cexAlerts, bridgeDailyAlert, bridgePacePerDay, hyperlaneFlows, hyperlaneWeeklyAlert, mdToHtml, md } from "../services/argusAlertRules.js";

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
