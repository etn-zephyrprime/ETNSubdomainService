// Pure tests for services/etnHedgeStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { kucoinFill, decideHedge, freshHedgeBook, applyHedge, HEDGE_DEFAULTS } from "../services/etnHedgeStrategy.js";

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
