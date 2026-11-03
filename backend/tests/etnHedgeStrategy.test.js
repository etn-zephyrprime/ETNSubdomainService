// Pure tests for services/etnHedgeStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { kucoinFill, decideHedge, freshHedgeBook, applyHedge, HEDGE_DEFAULTS, etnToSellForUsd, freshLiveHedgeBook, applyLiveHedge } from "../services/etnHedgeStrategy.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("filling against KuCoin's book walks the levels; too shallow is null", () => {
  const asks = [["0.0020", "10000"], ["0.0021", "10000"]];
  const f = kucoinFill(asks, 15000, "buy");
  close(f.usd, 10000 * 0.002 + 5000 * 0.0021);
  close(f.avgPrice, f.usd / 15000);
  assert.equal(kucoinFill(asks, 25000, "buy"), null);
});

test("sell on ElectroSwap / buy on KuCoin: profit after KuCoin's fee; too thin is skipped", () => {
  // 25,000 ETN sold on ElectroSwap for $52.00, bought back on KuCoin for $50.00 (+0.1% fee = $50.05)
  const h = decideHedge([{ dir: "sellOnEs", stable: "USDC", etn: 25000, esUsd: 52, kcUsd: 50 }]);
  close(h.profitUsd, 52 - 50 * 1.001);
  // 0.2% edge -> under the 0.3% bar
  assert.equal(decideHedge([{ dir: "sellOnEs", stable: "USDC", etn: 25000, esUsd: 50.2, kcUsd: 50 }]), null);
});

test("buy on ElectroSwap / sell on KuCoin, and the most profitable size wins", () => {
  const h = decideHedge([
    { dir: "buyOnEs", stable: "USDT", usd: 45, etn: 24000, kcUsd: 46.5 },
    { dir: "buyOnEs", stable: "USDT", usd: 90, etn: 47000, kcUsd: 92.0 },
  ]);
  assert.equal(h.usd, 90);
  close(h.profitUsd, 92 * 0.999 - 90);
  assert.equal(HEDGE_DEFAULTS.lagPct, 1.5);
});

test("the paper book: profit in $ and ETN, and the rebalancing each direction leaves behind", () => {
  const b = freshHedgeBook();
  applyHedge(b, { dir: "sellOnEs", stable: "USDC", etn: 25000, notional: 52, profitUsd: 1.95, profitPct: 3.75 }, { kucoinPrice: 0.002 });
  applyHedge(b, { dir: "buyOnEs", stable: "USDT", etn: 10000, notional: 19, profitUsd: 0.5, profitPct: 2.6 }, { kucoinPrice: 0.002 });
  assert.equal(b.trades, 2);
  close(b.profitUsd, 2.45);
  close(b.profitEtn, 1225);
  assert.deepEqual(b.drift, { etnToWallet: 15000, usdToKucoin: 33 });
});

test("live: ETN to sell on KuCoin for a dollar amount after the fee", () => {
  const bids = [["0.0020", "10000"], ["0.0019", "100000"]];
  // $25 after 0.1% fee needs $25.025 gross: 10,000 at 0.002 = $20, then $5.025 / 0.0019 = 2,644.7
  close(etnToSellForUsd(bids, 25, 0.1), 10000 + 5.025025025 / 0.0019, 1e-6);
  assert.equal(etnToSellForUsd(bids, 1000, 0.1), null);
});

test("live hedge book: profit in ETN both ways; dollars and ETN shift between venues", () => {
  const b = freshLiveHedgeBook();
  // sell 25,000 ETN on ElectroSwap for $52, spend it on KuCoin -> 26,000 ETN
  close(applyLiveHedge(b, { dir: "sellOnEs", stable: "USDC", esEtn: 25000, esUsd: 52, kcEtn: 26000, kcUsd: 52 }), 1000);
  // spend $20 of it on ElectroSwap -> 11,000 ETN, sell 10,400 on KuCoin for $20
  close(applyLiveHedge(b, { dir: "buyOnEs", stable: "USDC", esEtn: 11000, esUsd: 20, kcEtn: 10400, kcUsd: 20 }), 600);
  close(b.gainEtn, 1600);
  assert.deepEqual(b.stables, { USDT: 0, USDC: 32 });
  assert.equal(b.walletEtnNet, -14000);
  assert.equal(b.kucoinEtnNet, 15600);
  assert.equal(b.kucoinUsdNet, -32);
});
