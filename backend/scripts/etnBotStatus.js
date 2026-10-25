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
import { ethers } from "ethers";
import { gatherQuotes, readConfig, POOLS } from "../utils/etnAccumulatorBot.js";
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
  const provider = createRpcProvider();
  const { buyback } = await gatherQuotes(provider, state, readConfig().clipEtn);
  // What the gap book's stablecoin would buy in ETN right now.
  let gapStablesEtn = 0;
  if (state.gap) {
    const quoter = new ethers.Contract(process.env.ELECTROSWAP_V3_QUOTER_ADDRESS || "0xba3CAfCc197E71b9d114E515E75c037dA09A6312", ["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)"], provider);
    for (const [k, p] of Object.entries(POOLS)) {
      const usd = state.gap.stables[k] || 0;
      if (usd < 0.01) continue;
      const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn: p.token, tokenOut: "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77", amountIn: ethers.parseUnits((Math.floor(usd * 1e6) / 1e6).toFixed(6), 6), fee: p.fee, sqrtPriceLimitX96: 0 });
      gapStablesEtn += Number(ethers.formatEther(r[0]));
    }
  }
  const s = summarize(state, buyback, gapStablesEtn);

  console.log(`\nETN accumulator bot — ${mode.toUpperCase()} (since ${state.startedAt}, updated ${state.updatedAt})`);
  const deposits = Object.entries(s.gapDepositsUsd || {}).filter(([, v]) => Math.abs(v) >= 0.01);
  console.log(`  Budget:            ${etn(s.budgetEtn)} ETN${deposits.length ? `  + topped up ${deposits.map(([k, v]) => `$${v.toFixed(2)} ${k}`).join(" + ")} (= ${etn(s.contributedEtn - s.budgetEtn)} ETN when added)` : ""}`);
  console.log(`  Cycles closed:     ${s.cyclesClosed}   realized gain: ${s.realizedGainEtn >= 0 ? "+" : ""}${etn(s.realizedGainEtn)} ETN`);
  console.log(`  Open lots:         ${s.lotsOpen}   (${etn(s.openEtnSold)} ETN sold${s.openBuybackEtn != null ? `, would buy back ${etn(s.openBuybackEtn)} now` : ""})`);
  console.log(`  ETN if closed now: ${etn(s.etnEquivalentNow)} ETN  (${s.vsHoldPct >= 0 ? "+" : ""}${s.vsHoldPct.toFixed(2)}% vs just holding${deposits.length ? ` the ${etn(s.contributedEtn)} ETN put in` : ""})`);
  if (state.gap) {
    console.log(`  Gap trades:        ${s.gapTrades}   gained: +${etn(s.gapGainEtn)} ETN   (seed ${etn(s.gapSeedEtn)} ETN; book now $${(state.gap.stables.USDT || 0).toFixed(2)} USDT + $${(state.gap.stables.USDC || 0).toFixed(2)} USDC = ${etn(gapStablesEtn)} ETN)`);
    if (state.gapLeg) console.log(`  GAP LEG OPEN:      sold ${etn(state.gapLeg.etnSold)} ETN into ${state.gapLeg.dear}; buy leg in ${state.gapLeg.cheap} still to run`);
  }
  console.log(`  Price EMA:         $${state.ema?.toPrecision(4)} over ${state.samples} samples`);
  if (state.pending) console.log(`  PENDING tx:        ${state.pending.kind} ${state.pending.txHash}`);

  if (state.gap?.recent?.length) {
    console.log("\n  Recent gap trades:  sold in   ETN sold    $       ETN back    gain");
    for (const t of state.gap.recent.slice(-10)) console.log(`  ${(t.at || "").slice(5, 16).padEnd(18)} ${t.dear.padEnd(6)} ${etn(t.etnSold).padStart(9)}  ${t.stableReceived.toFixed(2).padStart(6)}  ${etn(t.etnBought).padStart(9)}   ${t.gainEtn >= 0 ? "+" : ""}${etn(t.gainEtn)}`);
  }

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
