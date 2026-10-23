// backend/scripts/etnBotStatus.js
//
// Read-only: the ETN accumulator bot's books (utils/etnAccumulatorBot.js) plus live buyback quotes
// for its open lots — how much ETN it has gained, and what it would hold if it closed everything now.
//
// Usage (from backend/):
//   node scripts/etnBotStatus.js           the mode in ETN_BOT_MODE (paper unless set to live)
//   node scripts/etnBotStatus.js --live    the live books
//   node scripts/etnBotStatus.js --paper   the paper books
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getBotState } from "../state/etnAccumulatorBotState.js";
import { gatherQuotes, readConfig } from "../utils/etnAccumulatorBot.js";
import { summarize } from "../services/etnAccumulatorStrategy.js";

dotenv.config();

const args = process.argv.slice(2);
const mode = args.includes("--live") ? "live" : args.includes("--paper") ? "paper" : readConfig().mode;
const etn = (n) => Math.round(n).toLocaleString("en-US");

async function main() {
  const state = await getBotState(mode);
  if (!state) {
    console.log(`No ${mode} books yet — the bot hasn't run in ${mode} mode.`);
    return;
  }
  const { buyback } = await gatherQuotes(createRpcProvider(), state, readConfig().clipEtn);
  const s = summarize(state, buyback);

  console.log(`\nETN accumulator bot — ${mode.toUpperCase()} (since ${state.startedAt}, updated ${state.updatedAt})`);
  console.log(`  Budget:            ${etn(s.budgetEtn)} ETN`);
  console.log(`  Cycles closed:     ${s.cyclesClosed}   realized gain: ${s.realizedGainEtn >= 0 ? "+" : ""}${etn(s.realizedGainEtn)} ETN`);
  console.log(`  Open lots:         ${s.lotsOpen}   (${etn(s.openEtnSold)} ETN sold${s.openBuybackEtn != null ? `, would buy back ${etn(s.openBuybackEtn)} now` : ""})`);
  console.log(`  ETN if closed now: ${etn(s.etnEquivalentNow)} ETN  (${s.vsHoldPct >= 0 ? "+" : ""}${s.vsHoldPct.toFixed(2)}% vs just holding)`);
  console.log(`  Price EMA:         $${state.ema?.toPrecision(4)} over ${state.samples} samples`);
  if (state.pending) console.log(`  PENDING tx:        ${state.pending.kind} ${state.pending.txHash}`);

  if (state.lots.length) {
    console.log("\n  #    status  stable   ETN sold     stable   sell price    ETN back   gain");
    for (const l of state.lots.slice(-25)) {
      const back = l.status === "closed" ? l.etnBought : buyback[l.id];
      const gain = back ? `${((back / l.etnSold - 1) * 100).toFixed(1)}%${l.status === "open" ? " (now)" : ""}` : "—";
      console.log(`  ${String(l.id).padEnd(4)} ${l.status.padEnd(7)} ${l.stable.padEnd(6)} ${etn(l.etnSold).padStart(9)}  ${l.stableAmount.toFixed(2).padStart(9)}   ${l.sellPrice.toPrecision(4).padStart(10)}   ${back ? etn(back).padStart(9) : "        —"}   ${gain}`);
    }
  }
}

main().catch((err) => {
  console.error("❌ ETN bot status failed:", err.message);
  process.exitCode = 1;
});
