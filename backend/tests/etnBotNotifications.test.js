import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ETN_BOT_ALERT_WALLET, etnBotAlertWallets, formatEtnBotNotification } from "../services/etnBotNotifications.js";

test("ETN Bot alert recipients default only to the 5099 wallet and can be overridden", () => {
  assert.deepEqual([...etnBotAlertWallets(undefined)], [DEFAULT_ETN_BOT_ALERT_WALLET.toLowerCase()]);
  assert.deepEqual([...etnBotAlertWallets("0xAbC, 0xabc, 0xDef")], ["0xabc", "0xdef"]);
  assert.equal(etnBotAlertWallets("").size, 0);
});

test("notifications label mode, include realized accrued ETN, and keep paper estimates separate", () => {
  const state = {
    realizedGainEtn: 10,
    gap: { gainEtn: 20 },
    tri: { gainEtn: 30 },
    cu: { gainEtn: 40 },
    hedgeLive: { gainEtn: 50, costsEtn: 5 },
    cexArb: { gainEtn: 60, costsEtn: 6, paper: { profitUsd: 9999 } },
    hedge: { profitUsd: 9999 },
  };
  const live = formatEtnBotNotification("Trade completed", "live", state);
  assert.match(live, /ETN Accumulator Bot — LIVE/);
  assert.match(live, /Realized ETN accrued: \+199 ETN/);
  assert.doesNotMatch(live, /9999/);

  const paper = formatEtnBotNotification("Opportunity observed", "paper", state);
  assert.match(paper, /ETN Accumulator Bot — PAPER/);
  assert.match(paper, /strategy trades are simulated/);

  const opportunity = formatEtnBotNotification("Spread detected; not executed", "opportunity", state);
  assert.match(opportunity, /ETN Accumulator Bot — MARKET OPPORTUNITY/);
  assert.doesNotMatch(opportunity, /Realized ETN accrued|9999|PAPER/);
});
