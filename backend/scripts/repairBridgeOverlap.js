// backend/scripts/repairBridgeOverlap.js
//
// One-off repair for the 3 Nov 2026 23:25 deploy, when two bot instances ran side by side (fixed for the
// future by the lease in PR #468). The new instance bridged the hedge book's $89.12 USDC to KuCoin
// (tx BRIDGE_TX); the old one, still holding books from before the bridge, saw $89.12 "missing" from
// the wallet, took it out of the GAP book, and its save overwrote the new instance's bridge record.
// Result: the hedge book still counts $89.12 USDC in the wallet that left, the gap book is $89.12
// short of USDC that's really there, and the bridge fee never reached the hedge book's costs.
//
// This moves the $89.12 back (hedge book -> gap book, ETN value = the 45,987 ETN the two hedges sold
// for it) and adds the bridge fee read from the transaction. Dry run by default; --apply takes the
// bot's lease so it stands by while the books are edited, then hands it back.
//
// Usage (from backend/, in the Render shell):
//   node scripts/repairBridgeOverlap.js
//   node scripts/repairBridgeOverlap.js --apply
import dotenv from "dotenv";
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getBotState, setBotState, forceBotLease, releaseBotLease } from "../state/etnAccumulatorBotState.js";
import { applyGapDeposit } from "../services/etnGapStrategy.js";

dotenv.config();

const REPAIR_ID = "bridge-overlap-2026-11-03";
const BRIDGE_TX = "0xd0db24a718bf4080b7e31432fcdfadfcde3ebe4932d01e03f52ca16ba7380ead";
const USD = 89.12;
const ETN_VALUE = 45987; // what the 22:25 + 22:31 hedges sold on ElectroSwap for that USDC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(state) {
  if (!state) throw new Error("no live books in R2");
  if ((state.repairs || []).includes(REPAIR_ID)) return "already applied";
  const hb = state.hedgeLive;
  if (!hb) return "no live hedge book";
  if (Math.abs((hb.stables?.USDC || 0) - USD) > 0.05) return `hedge book holds $${(hb.stables?.USDC || 0).toFixed(2)} USDC, not $${USD} — books changed since; not touching them`;
  if ((hb.inTransit || []).some((t) => t.tx === BRIDGE_TX)) return "the bridge is already recorded in the hedge book";
  if (!state.gap) return "no gap book";
  return null;
}

function show(state, label) {
  const hb = state.hedgeLive;
  console.log(`  ${label}: hedge book wallet USDC $${(hb.stables.USDC || 0).toFixed(2)}, hedge costs ${(hb.costsEtn || 0).toFixed(2)} ETN; gap book USDC $${(state.gap.stables.USDC || 0).toFixed(2)} (top-ups $${(state.gap.depositsUsd?.USDC || 0).toFixed(2)}), deposit ETN ${Math.round(state.gap.depositEtn || 0).toLocaleString("en-US")}`);
}

function repair(state, feeEtn) {
  const hb = state.hedgeLive;
  hb.stables.USDC = (hb.stables.USDC || 0) - USD;
  hb.costsEtn = (hb.costsEtn || 0) + feeEtn;
  applyGapDeposit(state.gap, "USDC", USD, ETN_VALUE);
  state.repairs = [...(state.repairs || []), REPAIR_ID];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const provider = createRpcProvider();
  const [tx, receipt] = await Promise.all([provider.getTransaction(BRIDGE_TX), provider.getTransactionReceipt(BRIDGE_TX)]);
  if (!tx || receipt?.status !== 1) throw new Error("bridge transaction not found or failed — nothing to repair");
  const feeEtn = Number(ethers.formatEther(tx.value));
  console.log(`Bridge tx confirmed: $${USD} USDC to KuCoin, Hyperlane fee ${feeEtn.toFixed(2)} ETN`);

  let state = await getBotState("live");
  const problem = check(state);
  if (problem) return console.log(`Nothing to do: ${problem}`);
  show(state, "now  ");
  const after = structuredClone(state);
  repair(after, feeEtn);
  show(after, "after");
  if (!apply) return console.log("\nDry run — run again with --apply to save it.");

  const owner = `repair:${process.pid}`;
  await forceBotLease(owner);
  try {
    console.log("Took the bot's lease; waiting 45s for any check in progress to finish…");
    await sleep(45000);
    state = await getBotState("live"); // fresh, in case a check saved meanwhile
    const again = check(state);
    if (again) return console.log(`Stopped: ${again}`);
    repair(state, feeEtn);
    await setBotState("live", state);
    await sleep(3000);
    const saved = await getBotState("live");
    if (!(saved.repairs || []).includes(REPAIR_ID)) throw new Error("the save didn't stick — run it again");
    show(saved, "saved");
    console.log("✅ Repaired.");
  } finally {
    await releaseBotLease(owner);
    console.log("Lease released — the bot picks up on its next check.");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exitCode = 1;
});
