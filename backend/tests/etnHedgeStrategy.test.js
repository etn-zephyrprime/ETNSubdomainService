// Pure tests for services/etnHedgeStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { kucoinFill, decideHedge, freshHedgeBook, applyHedge, HEDGE_DEFAULTS, etnToSellForUsd, freshLiveHedgeBook, applyLiveHedge, decideRebalance, settleArrival, sweepAmount, SWEEP_DEFAULTS, REFILL_DEFAULTS, decideEtnRefill, decideUsdtRefill } from "../services/etnHedgeStrategy.js";

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

test("rebalancing: one transfer per check, in priority order", () => {
  const hb = { stables: { USDC: 120, USDT: 50 }, inTransit: [] };
  const kc = (trade, main = { ETN: 0, USDT: 0, USDC: 0 }) => ({ trade: { USDC: 0, ...trade }, main });
  // an arrived deposit is swept first
  assert.deepEqual(decideRebalance(kc({ ETN: 300000, USDT: 10 }, { ETN: 0, USDT: 0, USDC: 119.5 }), hb, 1e9), { type: "sweepUsdc", amount: 119.5 });
  // ETN piled up on KuCoin -> withdraw down to the target
  assert.deepEqual(decideRebalance(kc({ ETN: 300000, USDT: 10 }), hb, 1e9), { type: "withdrawEtn", amount: 200000 });
  // KuCoin short of USDT -> bridge the hedge's USDC (Base)
  assert.deepEqual(decideRebalance(kc({ ETN: 150000, USDT: 10 }), hb, 1e9), { type: "bridgeUsdc", amount: 120 });
  // ...but not while a USDC bridge is already on its way
  assert.equal(decideRebalance(kc({ ETN: 150000, USDT: 10 }), { ...hb, inTransit: [{ currency: "USDC", usd: 100 }] }, 1e9), null);
  // USDT only in batches of $300+
  assert.deepEqual(decideRebalance(kc({ ETN: 150000, USDT: 500 }), { stables: { USDT: 320 }, inTransit: [] }, 1e9), { type: "bridgeUsdt", amount: 320 });
  // KuCoin short of ETN -> deposit up to the target, within what the bot may send
  assert.deepEqual(decideRebalance(kc({ ETN: 20000, USDT: 500 }), { stables: {}, inTransit: [] }, 50000), { type: "depositEtn", amount: 50000 });
  assert.equal(decideRebalance(kc({ ETN: 150000, USDT: 500 }), { stables: {}, inTransit: [] }, 1e9), null);
});

test("arrivals clear what they cover", () => {
  const hb = { inTransit: [{ currency: "USDC", usd: 60 }, { currency: "USDC", usd: 50 }, { currency: "ETN", etn: 1000 }] };
  settleArrival(hb, "USDC", 59.9);
  assert.deepEqual(hb.inTransit, [{ currency: "USDC", usd: 50 }, { currency: "ETN", etn: 1000 }]);
});

test("rebalancing: USDC already in the trading account is converted (retry-safe), after any sweep", () => {
  const hb = { stables: {}, inTransit: [] };
  const z = { ETN: 0, USDT: 0, USDC: 0 };
  assert.deepEqual(decideRebalance({ trade: { ETN: 150000, USDT: 500, USDC: 52.5 }, main: z }, hb, 0), { type: "convertUsdc", amount: 52.5 });
  assert.equal(decideRebalance({ trade: { ETN: 150000, USDT: 500, USDC: 52.5 }, main: { ...z, USDC: 10 } }, hb, 0).type, "sweepUsdc");
});

test("sweeping: only what's above the float, and only in worthwhile batches", () => {
  assert.equal(sweepAmount(220000, SWEEP_DEFAULTS.kucoin), 170000); // keep 50k, withdraw the rest
  assert.equal(sweepAmount(90000, SWEEP_DEFAULTS.kucoin), 0); // 40k over: under the 50k batch (fee 308 ETN)
  assert.equal(sweepAmount(115000, SWEEP_DEFAULTS.htx), 15000); // HTX: nearly free, smaller batches
  assert.equal(sweepAmount(105000, SWEEP_DEFAULTS.htx), 0);
  assert.equal(sweepAmount(100500, { float: 100000, minBatch: 0 }, 616), 0); // below the venue's withdrawal minimum
});

test("refilling HTX's ETN: below the low mark, up to the target, never draining the wallet", () => {
  const cfg = REFILL_DEFAULTS;
  assert.equal(decideEtnRefill({ htxEtn: 60000, walletEtn: 1e6 }, cfg), 0); // above the low mark
  assert.equal(decideEtnRefill({ htxEtn: 22871, walletEtn: 1e6 }, cfg), 57100); // up to 80k, in 100s
  assert.equal(decideEtnRefill({ htxEtn: 22871, walletEtn: 1e6, pending: true }, cfg), 0); // one in flight
  // the wallet keeps 50k + the open catch-up lots' ETN
  assert.equal(decideEtnRefill({ htxEtn: 20000, walletEtn: 100000, lotEtn: 23414 }, cfg), 26500);
  assert.equal(decideEtnRefill({ htxEtn: 20000, walletEtn: 80000, lotEtn: 23414 }, cfg), 0); // only ~6.6k spare
  assert.equal(decideEtnRefill({ htxEtn: 45000, walletEtn: 1e6, depositMin: 200 }, { ...cfg, minEtn: 0 }), 35000);
});

test("refilling KuCoin's USDT from HTX: below the low mark, keeping some on HTX", () => {
  const cfg = REFILL_DEFAULTS;
  assert.equal(decideUsdtRefill({ kucoinUsdt: 120, htxUsdt: 500 }, cfg), 0);
  assert.equal(decideUsdtRefill({ kucoinUsdt: 41.43, htxUsdt: 149.07, fee: 0.01 }, cfg), 99.06); // HTX keeps $50
  assert.equal(decideUsdtRefill({ kucoinUsdt: 41.43, htxUsdt: 500, fee: 0.01 }, cfg), 158.57); // up to $200
  assert.equal(decideUsdtRefill({ kucoinUsdt: 10, htxUsdt: 70 }, cfg), 0); // $20 spare: under the $30 batch
  assert.equal(decideUsdtRefill({ kucoinUsdt: 10, htxUsdt: 500, pending: true }, cfg), 0);
});
