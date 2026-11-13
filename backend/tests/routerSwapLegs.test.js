// Universal Router swap legs + farm ETN double count — fixtures trimmed from real Electroneum txs
// (2026-11-13 ledger drift scan): 0xf550509d… (fee leg), 0xcca664d8… / 0x85950983… (ETN refunds),
// 0xe5db6890… (native-ETN farm #5 deposit).
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { deriveSwapLegs, fetchSwapInternalTxs } from "../services/pnlIngestion.js";
import { assembleLedgerEvents } from "../services/pnlEventBuilder.js";

const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const pad = (a) => ethers.zeroPadValue(a, 32);
const WALLET = "0x7ef3096b04a36e44a3791b4880e96164d791e318";
const ROUTER = "0x2c12c8f15637b7a182dec202816148a5e767dcec";
const V2_PAIR = "0x1111111111111111111111111111111111111111";
const V3_POOL = "0x2222222222222222222222222222222222222222";
const FEE = "0xd6cf49cb00000000000000000000000000000000";
const BOLT = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";
const CORE = "0x309b916b3a90cb3e071697ea9680e9217a30066f";
const WETN = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const DYNO = "0xee432c220273e4f949007b4c1946562826efa055";
const wei = (n) => ethers.parseEther(String(n)).toString();

const v2SwapLog = (pair, to) => ({
  address: { hash: pair },
  topics: [SWAP_TOPIC, pad(ROUTER), pad(to), null],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256", "uint256"], [1, 0, 0, 1]),
  index: 7,
});
const v3SwapLog = (pool) => ({ address: { hash: pool }, topics: [ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)")], data: "0x", index: 3 });
const tt = (token, from, to, amount) => ({ token: { address: token, decimals: "18", type: "ERC-20" }, from: { hash: from }, to: { hash: to }, total: { value: wei(amount) } });

test("router fee leg: the 0.3% sent to the fee address counts as sold", () => {
  const tx = { from: { hash: WALLET }, to: { hash: ROUTER }, value: "0" };
  const logs = [v3SwapLog(V3_POOL), v2SwapLog(V2_PAIR, WALLET)];
  const transfers = [
    tt(BOLT, WALLET, FEE, 30),
    tt(WETN, V3_POOL, ROUTER, 23311.068),
    tt(BOLT, WALLET, V3_POOL, 9970),
    tt(WETN, ROUTER, V2_PAIR, 23311.068),
    tt(CORE, V2_PAIR, "0x4eb4b9ce00000000000000000000000000000000", 4.6957),
    tt(CORE, V2_PAIR, WALLET, 1541.7591),
  ];
  const legs = deriveSwapLegs(WALLET, tx, logs, transfers);
  assert.equal(legs.soldAddress, BOLT);
  assert.equal(legs.soldAmount, 10000);
  assert.equal(legs.boughtAddress, CORE);
  assert.equal(legs.boughtAmount, 1541.7591);
});

test("a fee-address transfer from someone else (not the wallet) is not counted", () => {
  const tx = { from: { hash: WALLET }, to: { hash: ROUTER }, value: "0" };
  const logs = [v3SwapLog(V3_POOL), v2SwapLog(V2_PAIR, WALLET)];
  const transfers = [tt(BOLT, ROUTER, FEE, 30), tt(BOLT, WALLET, V3_POOL, 9970), tt(CORE, V2_PAIR, WALLET, 1541.7591)];
  assert.equal(deriveSwapLegs(WALLET, tx, logs, transfers).soldAmount, 9970);
});

test("ETN-paid exact-output buy: the internal ETN refund is subtracted from ETN sold", async () => {
  const tx = { from: { hash: WALLET }, to: { hash: ROUTER }, value: wei("6173.394300909542511919") };
  const logs = [v3SwapLog(V3_POOL), v2SwapLog(V2_PAIR, WALLET)];
  const transfers = [
    tt(WETN, ethers.ZeroAddress, ROUTER, 6173.3943),
    tt(WETN, ROUTER, V2_PAIR, 257.3435),
    tt(DYNO, V2_PAIR, WALLET, 0.135),
    tt(DYNO, V3_POOL, WALLET, 2.565),
    tt(WETN, ROUTER, V3_POOL, 4887.1518),
    tt(WETN, ROUTER, ethers.ZeroAddress, 1028.8991),
  ];
  const internals = [
    { from: { hash: ROUTER }, to: { hash: WETN }, value: wei("6173.394300909542511919"), success: true },
    { from: { hash: WETN }, to: { hash: ROUTER }, value: wei("1028.8991"), success: true },
    { from: { hash: ROUTER }, to: { hash: WALLET }, value: wei("1028.8991"), success: true },
  ];
  const before = deriveSwapLegs(WALLET, tx, logs, transfers);
  assert.equal(before.soldAddress, "NATIVE");
  assert.ok(Math.abs(before.soldAmount - 6173.3943) < 1e-3, "no internals = old msg.value behavior");

  const fetched = await fetchSwapInternalTxs(before, "0xcca6", async () => internals);
  const legs = deriveSwapLegs(WALLET, tx, logs, transfers, fetched);
  assert.ok(Math.abs(legs.soldAmount - 5144.4952) < 1e-3, String(legs.soldAmount));
  assert.equal(legs.boughtAddress, DYNO);
  assert.ok(Math.abs(legs.boughtAmount - 2.7) < 1e-9);
});

test("internal txs are only fetched for swaps with an ETN leg, and a failed fetch falls back", async () => {
  let calls = 0;
  const get = async () => (calls++, []);
  assert.equal(await fetchSwapInternalTxs({ soldAddress: BOLT, boughtAddress: CORE }, "0x1", get), null);
  assert.equal(calls, 0);
  assert.equal(await fetchSwapInternalTxs(null, "0x1", get), null);
  assert.equal(await fetchSwapInternalTxs({ soldAddress: "NATIVE", boughtAddress: CORE }, "0x1", async () => { throw new Error("429"); }), null);
});

test("token -> ETN with an ETN payout via internal tx books what was received", () => {
  const tx = { from: { hash: WALLET }, to: { hash: ROUTER }, value: "0" };
  const logs = [v2SwapLog(V2_PAIR, WALLET)];
  const transfers = [tt(BOLT, WALLET, V2_PAIR, 100)];
  const internals = [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: wei(42), success: true }];
  const legs = deriveSwapLegs(WALLET, tx, logs, transfers, internals);
  assert.equal(legs.boughtAddress, "NATIVE");
  assert.equal(legs.boughtAmount, 42);
});

test("native-ETN farm deposit is booked once (lock), not also as a plain disposal", () => {
  const FARM = "0xe653ac16b732876f58a1722d24801230fa96bc82";
  const H = "0xe5db68900f4bf23e2d94712a1537166d42dc9b055009086b2c20228aba224b37";
  const ts = "2026-10-01T00:00:00Z";
  const row = (o) => ({ id: Math.random(), tx_hash: H, timestamp: ts, is_self_transfer: false, token_address: null, price_usd_at_time: 0.002, usd_value: 1, ...o });
  const transfers = [
    row({ log_index: -2, direction: "out", counterparty_address: FARM, amount_decimal: "102183.25" }), // the tx.value
    row({ log_index: -1, direction: "out", counterparty_address: FARM, amount_decimal: "0.5" }), // gas stays
    row({ tx_hash: "0xother", log_index: -2, direction: "out", counterparty_address: FARM, amount_decimal: "7" }), // not a farm tx: stays
  ];
  const defiActivity = [{ tx_hash: H, contract_address: FARM }];
  const defiEvents = [{ kind: "lock", tokenAddress: "NATIVE", txHash: H, timestamp: new Date(ts), quantity: "102183.25" }];
  const events = assembleLedgerEvents({ transfers, swaps: [], nftEvents: [], nftConsumedRowIds: new Set(), defiEvents, defiActivity });
  const farmTx = events.filter((e) => e.txHash === H);
  assert.deepEqual(farmTx.map((e) => `${e.kind}:${e.quantity}`).sort(), ["lock:102183.25", "out:0.5"]);
  assert.ok(events.some((e) => e.txHash === "0xother" && e.kind === "out"));
});

test("a plain ETN payment to a DIFFERENT contract in a farm tx is kept", () => {
  const FARM = "0xe653ac16b732876f58a1722d24801230fa96bc82";
  const ts = "2026-10-01T00:00:00Z";
  const transfers = [{ id: 1, tx_hash: "0xh", log_index: -2, direction: "out", counterparty_address: "0x9999999999999999999999999999999999999999", amount_decimal: "5", timestamp: ts, is_self_transfer: false, token_address: null }];
  const events = assembleLedgerEvents({ transfers, swaps: [], nftEvents: [], nftConsumedRowIds: new Set(), defiEvents: [], defiActivity: [{ tx_hash: "0xh", contract_address: FARM }] });
  assert.equal(events.length, 1);
});

test("farm tx rows written by the token/internal walks before the farm row existed are dropped (race)", () => {
  const FARM = "0xe653ac16b732876f58a1722d24801230fa96bc82";
  const H = "0xc2a5b8f0cdadc1567092339fc8bcf0bad7058e44ff5bb8ac404b9b98ce8b6e17";
  const BOLT = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";
  const DYNO = "0xee432c220273e4f949007b4c1946562826efa055";
  const ts = "2026-11-01T00:00:00Z";
  const row = (o) => ({ id: Math.random(), tx_hash: H, timestamp: ts, is_self_transfer: false, direction: "in", counterparty_address: FARM, price_usd_at_time: 0, usd_value: 0, ...o });
  const transfers = [
    row({ log_index: -1, direction: "out", token_address: null, amount_decimal: "0.01" }), // gas: kept
    row({ log_index: 5, token_address: DYNO, counterparty_address: "0x0000000000000000000000000000000000000000", amount_decimal: "3.5518" }),
    row({ log_index: 7, token_address: BOLT, amount_decimal: "106.1233" }),
    row({ log_index: 8, token_address: DYNO, amount_decimal: "0.1516" }),
    row({ log_index: -1003, token_address: null, amount_decimal: "1" }), // internal ETN on the farm tx: dropped too
    row({ tx_hash: "0xplain", log_index: 3, token_address: BOLT, amount_decimal: "50" }), // not a farm tx: kept
  ];
  const defiActivity = [{ tx_hash: H, contract_address: FARM }];
  const defiEvents = [
    { kind: "in", tokenAddress: BOLT, txHash: H, timestamp: new Date(ts), quantity: "106.1233", unitCostUsd: 0 },
    { kind: "in", tokenAddress: DYNO, txHash: H, timestamp: new Date(ts), quantity: "3.7034", unitCostUsd: 0 },
  ];
  const events = assembleLedgerEvents({ transfers, swaps: [], nftEvents: [], nftConsumedRowIds: new Set(), defiEvents, defiActivity });
  const onFarmTx = events.filter((e) => e.txHash === H).map((e) => `${e.kind}:${e.tokenAddress.slice(0, 6)}:${e.quantity}`).sort();
  assert.deepEqual(onFarmTx, ["in:0x043f:106.1233", "in:0xee43:3.7034", "out:NATIVE:0.01"]);
  assert.ok(events.some((e) => e.txHash === "0xplain"));
});
