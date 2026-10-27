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
import { summarize, botEtnInventory } from "../services/etnAccumulatorStrategy.js";

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

  // Led by ETN ACCUMULATED: ETN the bot's trades have added, which is what it's for. The stablecoin is
  // working capital, shown in dollars; its ETN value moves with ETN's price and isn't the goal, so the
  // mark-to-market "if everything were converted now" figure is the last line, not the headline.
  const accumulated = s.realizedGainEtn + s.gapGainEtn + s.triGainEtn + s.cuGainEtn;
  const days = Math.max((Date.parse(state.updatedAt) - Date.parse(state.startedAt)) / 86400000, 1 / 24);
  const signed = (n) => `${n >= 0 ? "+" : "−"}${etn(Math.abs(n))}`;
  const deposits = Object.entries(s.gapDepositsUsd || {}).filter(([, v]) => Math.abs(v) >= 0.01);

  console.log(`\nETN accumulator bot — ${mode.toUpperCase()} (since ${state.startedAt.slice(0, 16)}Z, updated ${state.updatedAt.slice(0, 16)}Z)`);
  console.log(`\n  ETN ACCUMULATED:     ${signed(accumulated)} ETN   (${((accumulated / s.budgetEtn) * 100).toFixed(2)}% of the ${etn(s.budgetEtn)} ETN budget, ~${signed(accumulated / days)} ETN/day)`);
  if (state.gap) console.log(`    from gap trades:   ${signed(s.gapGainEtn)} ETN over ${s.gapTrades} trade(s)`);
  if (state.tri) console.log(`    from triangles:    ${signed(s.triGainEtn)} ETN over ${s.triTrades} trade(s)`);
  if (state.cu) console.log(`    from KuCoin catch-up: ${signed(s.cuGainEtn)} ETN over ${s.cuClosed} closed lot(s)`);
  console.log(`    from sell/buyback: ${signed(s.realizedGainEtn)} ETN over ${s.cyclesClosed} cycle(s)`);

  console.log(`\n  ETN held by the bot: ${etn(botEtnInventory(state))} ETN   (budget${state.gap ? ", less the seed," : ""} plus gains${s.lotsOpen ? ", less open lots" : ""})`);
  if (state.gap) {
    const usdt = state.gap.stables.USDT || 0, usdc = state.gap.stables.USDC || 0;
    console.log(`  Working capital:     $${usdt.toFixed(2)} USDT + $${usdc.toFixed(2)} USDC = $${(usdt + usdc).toFixed(2)}   (from the ${etn(s.gapSeedEtn)} ETN seed${deposits.length ? ` + your top-ups of ${deposits.map(([k, v]) => `$${v.toFixed(2)} ${k}`).join(" + ")}` : ""})`);
    if (state.gapLeg) console.log(`  GAP LEG OPEN:        sold ${etn(state.gapLeg.etnSold)} ETN into ${state.gapLeg.dear}; buy leg in ${state.gapLeg.cheap} still to run`);
  }
  console.log(`  Open lots:           ${s.lotsOpen}${s.lotsOpen ? `   (${etn(s.openEtnSold)} ETN sold${s.openBuybackEtn != null ? `, would buy back ${etn(s.openBuybackEtn)} now` : ""})` : ""}`);
  console.log(`  Price EMA:           $${state.ema?.toPrecision(4)} over ${state.samples} samples`);
  if (state.pending) console.log(`  PENDING tx:          ${state.pending.kind} ${state.pending.txHash}`);

  if (state.gap?.recent?.length) {
    console.log("\n  Recent gap trades:  sold in   ETN sold    $       ETN back    gain");
    for (const t of state.gap.recent.slice(-10)) console.log(`  ${(t.at || "").slice(5, 16).padEnd(18)} ${t.dear.padEnd(6)} ${etn(t.etnSold).padStart(9)}  ${t.stableReceived.toFixed(2).padStart(6)}  ${etn(t.etnBought).padStart(9)}   ${t.gainEtn >= 0 ? "+" : ""}${etn(t.gainEtn)}`);
  }

  if (state.cu) {
    const cu = state.cu;
    console.log(`\n  KuCoin catch-up pot: $${(cu.cash.USDT || 0).toFixed(2)} USDT + $${(cu.cash.USDC || 0).toFixed(2)} USDC free (target $${(cu.target || 0).toFixed(2)}, funded $${(cu.funded || 0).toFixed(2)}); ${cu.lots.length} open lot(s)`);
    for (const l of cu.lots) console.log(`    open #${l.id}: $${l.usd.toFixed(2)} ${l.stable} -> ${etn(l.etn)} ETN at ${(l.openedAt || "").slice(5, 16)} (ElectroSwap was ${l.lagPct != null ? l.lagPct.toFixed(1) + "%" : "?"} vs KuCoin)`);
    for (const r of (cu.recent || []).slice(-10)) console.log(`    closed #${r.id}: ${etn(r.etnBought)} ETN in, ${etn(r.etnSold)} sold back for $${r.usdReceived.toFixed(2)} -> ${signed(r.gainEtn)} ETN`);
  }

  if (state.tri?.recent?.length) {
    console.log("\n  Recent triangles:   route                 ETN in     ETN out    gain");
    for (const t of state.tri.recent.slice(-10)) console.log(`  ${(t.at || "").slice(5, 16).padEnd(18)} ${t.route.padEnd(20)} ${etn(t.etnIn).padStart(8)}  ${etn(t.etnOut).padStart(9)}   ${signed(t.gainEtn)}`);
  }

  if (state.lots.length) {
    console.log("\n  #    status  stable   ETN sold     stable   sell price    ETN back   gain");
    for (const l of state.lots.slice(-25)) {
      const back = l.status === "closed" ? l.etnBought : buyback[l.id];
      const gain = back ? `${((back / l.etnSold - 1) * 100).toFixed(1)}%${l.status === "open" ? " (now)" : ""}` : "—";
      console.log(`  ${String(l.id).padEnd(4)} ${l.status.padEnd(7)} ${l.stable.padEnd(6)} ${etn(l.etnSold).padStart(9)}  ${l.stableAmount.toFixed(2).padStart(9)}   ${l.sellPrice.toPrecision(4).padStart(10)}   ${back ? etn(back).padStart(9) : "        —"}   ${gain}`);
    }
  }

  console.log(`\n  (Mark-to-market, moves with ETN's price: converting everything back to ETN right now would leave ${etn(s.etnEquivalentNow)} ETN against ${etn(s.contributedEtn)} ETN put in — after one-off fees and price impact.)`);
}

main().catch((err) => {
  console.error("❌ ETN bot status failed:", err.message);
  process.exitCode = 1;
});
