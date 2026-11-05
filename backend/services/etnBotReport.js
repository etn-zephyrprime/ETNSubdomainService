// backend/services/etnBotReport.js
//
// The ETN accumulator bot's live report as JSON, for the owner-only "ETN Bot" tab in Core Tier
// (/premium/etn-bot). Same figures as scripts/etnBotStatus.js: ETN accumulated per strategy, what the bot
// holds where, open positions, the hedge / CEX-arbitrage / sweep books, and a merged recent-activity feed.
// Live quotes and exchange balance calls are involved, so a report is cached for CACHE_MS.
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getBotState } from "../state/etnAccumulatorBotState.js";
import { gatherQuotes, readConfig, POOLS, botViewers } from "../utils/etnAccumulatorBot.js";
import { summarize, botEtnInventory } from "./etnAccumulatorStrategy.js";
import { catchupContributedEtn } from "./etnCatchupStrategy.js";
import { VENUES } from "./cexVenues.js";
import { getBalances as kucoinBalances } from "../utils/kucoinClient.js";

// Wallets allowed to see the bot (ETN_BOT_VIEWERS, comma-separated; defaults to the owner's two).
export { botViewers };

const CACHE_MS = 60 * 1000;
const WETN = "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77";
const QUOTER = process.env.ELECTROSWAP_V3_QUOTER_ADDRESS || "0xba3CAfCc197E71b9d114E515E75c037dA09A6312";
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

let cached = null;
let inFlight = null;

export async function getBotReport() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (!inFlight) inFlight = buildReport().then((report) => ((cached = { at: Date.now(), report }), report)).finally(() => (inFlight = null));
  return inFlight;
}

async function buildReport() {
  const cfg = readConfig();
  return buildReportFrom(await getBotState(cfg.mode), cfg);
}

/** The report for a given saved state (exported for testing). */
export async function buildReportFrom(state, cfg = readConfig()) {
  if (!state) return { mode: cfg.mode, empty: true };
  const provider = createRpcProvider();
  const { buyback } = await gatherQuotes(provider, state, cfg.clipEtn);
  const quoter = new ethers.Contract(QUOTER, ["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)"], provider);
  const usdToEtn = async (byStable) => {
    let total = 0;
    for (const [k, p] of Object.entries(POOLS)) {
      const usd = byStable[k] || 0;
      if (usd < 0.01) continue;
      const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn: p.token, tokenOut: WETN, amountIn: ethers.parseUnits((Math.floor(usd * 1e6) / 1e6).toFixed(6), 6), fee: p.fee, sqrtPriceLimitX96: 0 });
      total += Number(ethers.formatEther(r[0]));
    }
    return total;
  };
  const gapStablesEtn = state.gap ? await usdToEtn(state.gap.stables).catch(() => 0) : 0;
  let catchup = {};
  if (state.cu) {
    const cu = state.cu;
    const dollars = { USDT: cu.cash.USDT || 0, USDC: cu.cash.USDC || 0 };
    for (const l of cu.lots) if (l.kind === "sellFirst") dollars[l.stable] = (dollars[l.stable] || 0) + l.usd;
    const etnPerUsd = (await usdToEtn({ USDT: 10 }).catch(() => 0)) / 10;
    catchup = { heldEtn: cu.lots.filter((l) => l.kind !== "sellFirst").reduce((s, l) => s + l.etn, 0), stablesEtn: await usdToEtn(dollars).catch(() => 0), contributedEtn: catchupContributedEtn(cu, etnPerUsd) };
  }
  const s = summarize(state, buyback, gapStablesEtn, catchup);
  const hedgeNet = (state.hedgeLive?.gainEtn || 0) - (state.hedgeLive?.costsEtn || 0);
  const arbGain = (state.cexArb?.gainEtn || 0) - (state.cexArb?.costsEtn || 0); // net of withdrawal fees
  const byStrategy = [
    { key: "cu", label: "KuCoin catch-up", gainEtn: s.cuGainEtn || 0, count: s.cuClosed || 0, unit: "closed lots", on: Boolean(state.cu) },
    { key: "gap", label: "Gap trades", gainEtn: s.gapGainEtn || 0, count: s.gapTrades || 0, unit: "trades", on: Boolean(state.gap) },
    { key: "hedge", label: "Hedged trades (net of fees)", gainEtn: hedgeNet, count: state.hedgeLive?.trades || 0, unit: "hedges", on: Boolean(state.hedgeLive) },
    { key: "arb", label: "CEX arbitrage (net of fees)", gainEtn: arbGain, count: state.cexArb?.trades || 0, unit: "trades", on: Boolean(state.cexArb) },
    { key: "lots", label: "Sell / buyback", gainEtn: s.realizedGainEtn || 0, count: s.cyclesClosed || 0, unit: "cycles", on: true },
    { key: "tri", label: "Triangles", gainEtn: s.triGainEtn || 0, count: s.triTrades || 0, unit: "trades", on: Boolean(state.tri) },
  ];
  const accumulated = byStrategy.reduce((t, x) => t + x.gainEtn, 0);
  const days = Math.max((Date.parse(state.updatedAt) - Date.parse(state.startedAt)) / 86400000, 1 / 24);

  // Where the bot's money is right now.
  const walletAddr = process.env.ETN_BOT_WALLET || "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73";
  const wallet = { address: walletAddr, etn: Number(ethers.formatEther(await provider.getBalance(walletAddr).catch(() => 0n))) };
  for (const [k, p] of Object.entries(POOLS)) wallet[k] = Number(ethers.formatUnits(await new ethers.Contract(p.token, ERC20, provider).balanceOf(walletAddr).catch(() => 0n), p.decimals));
  const exchanges = {};
  for (const [k, v] of Object.entries(VENUES)) {
    if (!v.configured()) continue;
    const bal = await v.balances().catch((err) => ({ error: err.message }));
    exchanges[k] = { name: v.name, feePct: v.feePct, ...bal };
    if (k === "kucoin" && !bal.error) {
      const main = await kucoinBalances("main").catch(() => null);
      if (main) exchanges[k].main = main;
    }
  }

  // One merged activity feed, newest first.
  const activity = [];
  const push = (at, kind, text, gainEtn = null) => at && activity.push({ at, kind, text, gainEtn });
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  for (const r of state.cu?.recent || []) push(r.closedAt, "Catch-up", r.kind === "sellFirst" ? `Sold ${fmt(r.etnSold)} ETN, bought back ${fmt(r.etnBought)}` : `Bought ${fmt(r.etnBought)} ETN, sold ${fmt(r.etnSold)} back for $${r.usdReceived.toFixed(2)}`, r.gainEtn);
  for (const r of state.gap?.recent || []) push(r.at, "Gap", `Sold ${fmt(r.etnSold)} ETN in ${r.dear}, bought ${fmt(r.etnBought)} in ${r.cheap}`, r.gainEtn);
  for (const r of state.hedgeLive?.recent || []) push(r.at, "Hedge", r.dir === "sellOnEs" ? `Sold ${fmt(r.esEtn)} ETN on ElectroSwap, bought ${fmt(r.kcEtn)} on ${VENUES[r.venue]?.name || "KuCoin"}` : `Bought ${fmt(r.esEtn)} ETN on ElectroSwap, sold ${fmt(r.kcEtn)} on ${VENUES[r.venue]?.name || "KuCoin"}`, r.gainEtn);
  for (const r of state.cexArb?.recent || []) push(r.at, "CEX arb", `Bought ${fmt(r.etn)} ETN on ${VENUES[r.buyVenue]?.name}, sold on ${VENUES[r.sellVenue]?.name}`, r.gainEtn);
  for (const r of state.tri?.recent || []) push(r.at, "Triangle", `${r.route}: ${fmt(r.etnIn)} -> ${fmt(r.etnOut)} ETN`, r.gainEtn);
  for (const l of state.lots.filter((x) => x.status === "closed")) push(l.closedAt || l.boughtAt, "Sell/buyback", `Lot #${l.id}: sold ${fmt(l.etnSold)} ETN, bought back ${fmt(l.etnBought)}`, l.etnBought - l.etnSold);
  for (const [v, r] of Object.entries(state.cexSweep || {})) push(r.last, "Sweep", `Brought ETN home from ${VENUES[v]?.name || v} (${fmt(r.etn)} ETN in ${r.count} withdrawal(s) so far)`);
  const rf = state.cexRefill || {};
  if (rf.etn?.count) push(rf.etn.last, "Refill", `Sent ETN from the wallet to HTX (${fmt(rf.etn.etn)} ETN in ${rf.etn.count} transfer(s) so far)`);
  if (rf.usdt?.count) push(rf.usdt.last, "Refill", `Moved USDT from HTX to KuCoin (${rf.usdt.usd.toFixed(2)} in ${rf.usdt.count} withdrawal(s) so far)`);
  activity.sort((a, b) => (a.at < b.at ? 1 : -1));

  const issues = [];
  if (state.hedgeLive?.pausedReason) issues.push(`Hedging paused: ${state.hedgeLive.pausedReason}`);
  if (state.cexArb?.paused) issues.push(`CEX arbitrage paused: ${state.cexArb.paused}`);
  if (state.hedgeLeg) issues.push(`Unfinished hedge leg: ${fmt(state.hedgeLeg.esEtn)} ETN on ElectroSwap, ${state.hedgeLeg.venue || "kucoin"} leg pending`);
  if (state.arbLeg) issues.push(`Unfinished CEX arbitrage leg (${state.arbLeg.stage || "second"} leg)`);
  if (rf.etn?.pending) issues.push(`Refill in flight: ${fmt(rf.etn.pending.etn)} ETN wallet -> HTX since ${rf.etn.pending.at.slice(5, 16)}`);
  if (rf.usdt?.pending) issues.push(`Refill in flight: ${rf.usdt.pending.usd.toFixed(2)} USDT HTX -> KuCoin since ${rf.usdt.pending.at.slice(5, 16)}`);
  if (state.pending) issues.push(`On-chain trade in flight: ${state.pending.kind} ${state.pending.txHash}`);
  if (exchanges.kucoin?.main?.ETN >= 100) issues.push(`${fmt(exchanges.kucoin.main.ETN)} ETN sitting in KuCoin's Main account (not tradeable — move it to Trading or withdraw it)`);

  return {
    mode: cfg.mode,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    days,
    budgetEtn: s.budgetEtn,
    accumulated,
    perDay: accumulated / days,
    byStrategy,
    markToMarket: { etnNow: s.etnEquivalentNow, contributedEtn: s.contributedEtn },
    inventoryEtn: botEtnInventory(state),
    wallet,
    exchanges,
    switches: {
      hedging: cfg.hedgeLive ? "live" : cfg.hedgePaper ? "paper" : "off",
      cexArb: cfg.arbLive ? "live" : cfg.arbPaper ? "paper" : "off",
      sweep: cfg.cexSweep ? "on" : "off",
      roundTrip: cfg.hedgeRebalance ? "on" : "off",
      gap: cfg.gapEnabled ? "on" : "off",
      catchup: cfg.cuEnabled ? (cfg.cuSellEnabled ? "buy + sell" : "buy") : "off",
      triangles: cfg.triEnabled ? "on" : "off",
    },
    settings: { hedgeLagPct: cfg.hedgeLagPct, hedgeMaxUsd: cfg.hedgeMaxUsd, arbMinEdgePct: cfg.arb.minEdgePct, arbMaxUsd: Math.max(...cfg.arb.sizesUsd), cuLagPct: cfg.cuLagPct, cuMaxSellEtn: cfg.cuMaxSellEtn, gapMinGainPct: cfg.gapMinGainPct, sweepFloats: { kucoin: cfg.sweep.kucoin.float, htx: cfg.sweep.htx.float } },
    openCatchupLots: (state.cu?.lots || []).map((l) => ({ id: l.id, kind: l.kind === "sellFirst" ? "sell first" : "buy", stable: l.stable, usd: l.usd, etn: l.etn, openedAt: l.openedAt })),
    openLots: state.lots.filter((l) => l.status === "open").map((l) => ({ id: l.id, stable: l.stable, etnSold: l.etnSold, stableAmount: l.stableAmount, sellPrice: l.sellPrice, buybackEtnNow: buyback[l.id] ?? null })),
    gapBook: state.gap ? { USDT: state.gap.stables.USDT, USDC: state.gap.stables.USDC } : null,
    catchupPot: state.cu ? { USDT: state.cu.cash.USDT, USDC: state.cu.cash.USDC, target: state.cu.target } : null,
    hedge: state.hedgeLive ? { trades: state.hedgeLive.trades, gainEtn: state.hedgeLive.gainEtn, costsEtn: state.hedgeLive.costsEtn || 0, byVenue: state.hedgeLive.byVenue || {}, stables: state.hedgeLive.stables } : null,
    hedgePaper: state.hedge ? { trades: state.hedge.trades, profitUsd: state.hedge.profitUsd } : null,
    arb: state.cexArb ? { trades: state.cexArb.trades, gainEtn: state.cexArb.gainEtn, gainUsd: state.cexArb.gainUsd, costsEtn: state.cexArb.costsEtn || 0, today: state.cexArb.today, paper: state.cexArb.paper || null } : null,
    sweeps: state.cexSweep || {},
    refills: state.cexRefill || {},
    issues,
    activity: activity.slice(0, 40),
    generatedAt: new Date().toISOString(),
  };
}
