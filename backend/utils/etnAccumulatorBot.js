// backend/utils/etnAccumulatorBot.js
//
// ETN accumulator bot: cycles a fixed ETN budget through ElectroSwap's two USD farm pools (V3,
// 0.3% fee) — WETN/USDT 0x0CC6…F196 and WETN/USDC 0x2cB2…3Ad8A — selling clips of ETN on strength
// and buying them back only for more ETN than they sold. The rules live in
// services/etnAccumulatorStrategy.js (pure, tested); this file quotes, executes and keeps the books.
//
// Off unless ETN_BOT_ENABLED=true. ETN_BOT_MODE=paper (the default) makes every decision against
// real live quotes but sends nothing, filling at the quote — set ETN_BOT_MODE=live to trade. Paper
// and live keep separate books (state/etnAccumulatorBotState.js).
//
// Gap mode (ETN_BOT_GAP_ENABLED=true; rules in services/etnGapStrategy.js): the two pools often price
// ETN differently. Once seeded (ETN_BOT_GAP_SEED_ETN, half sold into each pool once), it sells ETN
// into the dearer pool and spends the same dollars of the other stablecoin on ETN in the cheaper one
// — two transactions, the second always completed (a restart between them finishes it first) — for
// at least ETN_BOT_GAP_MIN_GAIN_PCT more ETN, net of fees. Priority each tick: lot buyback, gap
// trade (or seeding), lot sale — at most one of them.
//
// Money safety:
//   - The bot only ever spends its own books: budget ETN (ETN_BOT_BUDGET_ETN) less what's out in
//     open lots (and in the gap book, below), and each open lot's / the gap book's own stablecoin. The wallet's other ETN is never touched, so it
//     can run on the admin wallet alongside the split/sweep schedulers. A failed books read skips
//     the tick rather than starting over (see the state file's header).
//   - Every swap is a real QuoterV2 quote, sent with amountOutMinimum = quote less ETN_BOT_SLIPPAGE_BPS
//     and a 5-minute deadline, and simulated (staticCall) before it's sent.
//   - A sent transaction is written to the books as `pending` (with its nonce) before waiting on it, so a restart
//     mid-trade picks the result up from its receipt instead of losing the lot.
//   - A gas reserve of native ETN is always left in the wallet; trades per day are capped; three
//     failed trades in a row pause the bot until the next restart.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import os from "os";
import { getBotState, setBotState, botStateConfigured, claimBotLease, releaseBotLease } from "../state/etnAccumulatorBotState.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";
import { DEFAULT_CONFIG, updateEma, decide, applySell, applyBuyback, botEtnInventory, profitNowEtn, profitFloorBlocks } from "../services/etnAccumulatorStrategy.js";
import { GAP_DEFAULTS, gapSizes, affordableLegEtn, decideGap, freshGapBook, applyGapSellLeg, applyGapBuyLeg, applyGapDeposit } from "../services/etnGapStrategy.js";
import { FAST_DEFAULTS, fastTriggerReason } from "../services/etnFastTrigger.js";
import { HEDGE_DEFAULTS, kucoinFill, decideHedge, freshHedgeBook, applyHedge, etnToSellForUsd, freshLiveHedgeBook, applyLiveHedge, REBALANCE_DEFAULTS, decideRebalance, settleArrival, SWEEP_DEFAULTS, sweepAmount, REFILL_DEFAULTS, decideEtnRefill, decideUsdtRefill } from "../services/etnHedgeStrategy.js";
import { VENUES, allBooks, feesOf, refreshFees } from "../services/cexVenues.js";
import { ARB_DEFAULTS, planArb, arbChecks, buyLegOrder, sellLegOrder, netFill, freshArbBook, roundDown, roundUp } from "../services/cexArbStrategy.js";
import { htxConfigured, getWithdrawRules as htxWithdrawRules, withdraw as htxWithdraw, getBalances as htxBalances, getDepositAddress as htxDepositAddress, getTransfers as htxTransfers } from "./htxClient.js";
import { kucoinConfigured, getTradeBalances, getSymbolRules, floorToIncrement, marketOrderAndWait, getOrderByClientOid, getBalances, getDepositAddress, innerTransfer, withdraw, getWithdrawRules, marketSellOn, getWithdrawals } from "./kucoinClient.js";
import { CATCHUP_DEFAULTS, freshCatchupBook, kucoinMid, lagsPct, decideCatchupBuy, decideCatchupClose, decideCatchupSell, decideCatchupBuyBack, applyCatchupBuy, applyCatchupClose, applyCatchupSell, applyCatchupBuyBack, applyCatchupFunding, splitDeposit, openSellUsd, openSellEtn } from "../services/etnCatchupStrategy.js";
import { TRIANGLE_DEFAULTS, TRIANGLE_ROUTES, TRIANGLE_POOLS, TRIANGLE_FEE, prescreenEdgePct, routeEdges, decideTriangle, triangleMinOut, freshTriangleBook, applyTriangleTrade } from "../services/etnTriangleStrategy.js";

const WETN = "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77";
const SWAP_ROUTER = "0x5A3AB7e9f405250B36e7e0a4654c1052EADC1F07"; // ElectroSwap SwapRouter02 (V3)
const QUOTER = process.env.ELECTROSWAP_V3_QUOTER_ADDRESS || "0xba3CAfCc197E71b9d114E515E75c037dA09A6312";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02's "keep it in the router" recipient

// WETN is token0 in both (read live 2026-10-23).
export const POOLS = {
  USDT: { token: "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7", decimals: 6, fee: 3000, pool: "0x0CC625331C9b22D94fEF29d462aB1c9B26dFF196" },
  USDC: { token: "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e", decimals: 6, fee: 3000, pool: "0x2cB2Af7aef7AB4cc3228F9c55EE8542Cb323Ad8A" },
};

const num = (name, dflt) => (process.env[name] != null && process.env[name] !== "" ? Number(process.env[name]) : dflt);
/** The wallets that see the ETN Bot tab (services/etnBotReport.js) and get its Telegram alerts. */
export function botViewers() {
  const list = process.env.ETN_BOT_VIEWERS || "0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099,0x696A7B9Ea5c86dA15D569d99D75ed788CcE4db2e";
  return new Set(list.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
}

export function readConfig() {
  return {
    mode: process.env.ETN_BOT_MODE === "live" ? "live" : "paper",
    budgetEtn: num("ETN_BOT_BUDGET_ETN", 100000),
    clipEtn: num("ETN_BOT_CLIP_ETN", DEFAULT_CONFIG.clipEtn),
    sellBandPct: num("ETN_BOT_SELL_BAND_PCT", DEFAULT_CONFIG.sellBandPct),
    sellStepPct: num("ETN_BOT_SELL_STEP_PCT", DEFAULT_CONFIG.sellStepPct),
    minGainPct: num("ETN_BOT_MIN_GAIN_PCT", DEFAULT_CONFIG.minGainPct),
    maxStableFraction: num("ETN_BOT_MAX_STABLE_FRACTION", DEFAULT_CONFIG.maxStableFraction),
    emaHalfLifeHours: num("ETN_BOT_EMA_HALF_LIFE_HOURS", DEFAULT_CONFIG.emaHalfLifeHours),
    warmupSamples: num("ETN_BOT_WARMUP_SAMPLES", DEFAULT_CONFIG.warmupSamples),
    intervalMs: num("ETN_BOT_INTERVAL_MS", 60000),
    slippageBps: num("ETN_BOT_SLIPPAGE_BPS", 50),
    // After 3 swaps in a row rejected in simulation only (nothing sent): pause this long, then carry on. 0 = wait for a restart.
    simPauseMs: num("ETN_BOT_SIM_PAUSE_MIN", 15) * 60000,
    // Profit floor (checkProfitFloor): while the bot's profit, counting open lots at today's quotes, is
    // below this many ETN, no NEW lots open (ladder sells, catch-up buys and sells); closes and the
    // instant round trips (gap, triangles, hedges, CEX arb) carry on. 0 = off.
    profitFloorEtn: num("ETN_BOT_PROFIT_FLOOR_ETN", 0),
    gasReserveEtn: num("ETN_BOT_GAS_RESERVE_ETN", 100),
    maxTradesPerDay: num("ETN_BOT_MAX_TRADES_PER_DAY", 24),
    gapEnabled: process.env.ETN_BOT_GAP_ENABLED === "true",
    gapSeedEtn: num("ETN_BOT_GAP_SEED_ETN", 20000),
    gapClipEtn: num("ETN_BOT_GAP_CLIP_ETN", GAP_DEFAULTS.clipEtn),
    gapMinGainPct: num("ETN_BOT_GAP_MIN_GAIN_PCT", GAP_DEFAULTS.minGainPct),
    gapMaxTradesPerDay: num("ETN_BOT_GAP_MAX_TRADES_PER_DAY", 48),
    triEnabled: process.env.ETN_BOT_TRI_ENABLED === "true",
    triMinGainEtn: num("ETN_BOT_TRI_MIN_GAIN_ETN", TRIANGLE_DEFAULTS.minGainEtn),
    triMaxEtn: num("ETN_BOT_TRI_MAX_ETN", 30000),
    triMaxTradesPerDay: num("ETN_BOT_TRI_MAX_TRADES_PER_DAY", 48),
    cuEnabled: process.env.ETN_BOT_CU_ENABLED === "true",
    cuPotUsd: num("ETN_BOT_CU_POT_USD", CATCHUP_DEFAULTS.potUsd),
    cuLagPct: num("ETN_BOT_CU_LAG_PCT", CATCHUP_DEFAULTS.lagPct),
    cuClipUsd: num("ETN_BOT_CU_CLIP_USD", CATCHUP_DEFAULTS.clipUsd),
    cuMinGainPct: num("ETN_BOT_CU_MIN_GAIN_PCT", CATCHUP_DEFAULTS.minGainPct),
    cuReentryMinutes: num("ETN_BOT_CU_REENTRY_MIN", CATCHUP_DEFAULTS.reentryMinutes),
    cuMaxTradesPerDay: num("ETN_BOT_CU_MAX_TRADES_PER_DAY", 48),
    cuSellEnabled: process.env.ETN_BOT_CU_SELL_ENABLED === "true",
    cuMaxSellEtn: num("ETN_BOT_CU_MAX_SELL_ETN", CATCHUP_DEFAULTS.maxSellEtn),
    // Fast watcher (see startFastWatcher): 0 turns it off.
    fastMs: num("ETN_BOT_FAST_MS", 5000),
    fastMovePct: num("ETN_BOT_FAST_MOVE_PCT", FAST_DEFAULTS.movePct),
    fastKucoinMs: num("ETN_BOT_FAST_KUCOIN_MS", 15000),
    fastMinSpacingMs: num("ETN_BOT_FAST_MIN_SPACING_MS", 15000),
    // Hedged catch-up, PAPER only (see etnHedgeStrategy.js): logs what selling on one venue and buying
    // on the other would have made. No orders, no KuCoin key. ETN_BOT_HEDGE_PAPER=false turns it off.
    hedgePaper: process.env.ETN_BOT_HEDGE_PAPER !== "false",
    hedgeLagPct: num("ETN_BOT_HEDGE_LAG_PCT", HEDGE_DEFAULTS.lagPct),
    hedgeKucoinFeePct: num("ETN_BOT_HEDGE_KUCOIN_FEE_PCT", HEDGE_DEFAULTS.kucoinFeePct),
    // LIVE hedging: only with ETN_BOT_HEDGE_LIVE=true, live mode, and the KuCoin key set (kucoinClient.js).
    hedgeLive: process.env.ETN_BOT_HEDGE_LIVE === "true" && process.env.ETN_BOT_MODE === "live" && kucoinConfigured(),
    hedgeMaxUsd: num("ETN_BOT_HEDGE_MAX_USD", 180), // largest hedge
    hedgeMaxEtnOut: num("ETN_BOT_HEDGE_MAX_ETN_OUT", 60000), // most of the bot's ETN that may sit on KuCoin at once
    hedgeMaxTradesPerDay: num("ETN_BOT_HEDGE_MAX_TRADES_PER_DAY", 48),
    // The round trip (rebalanceHedge): moving ETN and dollars back between KuCoin and the wallet. Needs the
    // key's Withdrawal permission; only with ETN_BOT_HEDGE_REBALANCE=true on top of live hedging.
    hedgeRebalance: process.env.ETN_BOT_HEDGE_REBALANCE === "true" && process.env.ETN_BOT_HEDGE_LIVE === "true" && process.env.ETN_BOT_MODE === "live" && kucoinConfigured(),
    hedgeRebalanceEveryMs: num("ETN_BOT_HEDGE_REBALANCE_EVERY_MIN", 10) * 60000,
    // CEX-vs-CEX arbitrage (KuCoin <-> HTX, cexArbCheck). PAPER logs opportunities from public data unless
    // ETN_BOT_CEX_ARB_PAPER=false; LIVE needs ETN_BOT_CEX_ARB_LIVE=true, live mode, and BOTH venues' keys.
    // Sweeping excess ETN off the exchanges back to the bot wallet (sweepExcessEtn): ETN_BOT_CEX_SWEEP=true,
    // live mode; each venue whose key is set (and allowed to withdraw) keeps only its float.
    cexSweep: process.env.ETN_BOT_CEX_SWEEP === "true" && process.env.ETN_BOT_MODE === "live",
    cexSweepEveryMs: num("ETN_BOT_CEX_SWEEP_EVERY_MIN", 10) * 60000,
    sweep: {
      kucoin: { float: num("ETN_BOT_KUCOIN_ETN_FLOAT", SWEEP_DEFAULTS.kucoin.float), minBatch: num("ETN_BOT_KUCOIN_SWEEP_MIN", SWEEP_DEFAULTS.kucoin.minBatch) },
      htx: { float: num("ETN_BOT_HTX_ETN_FLOAT", SWEEP_DEFAULTS.htx.float), minBatch: num("ETN_BOT_HTX_SWEEP_MIN", SWEEP_DEFAULTS.htx.minBatch) },
    },
    // Refilling the exchanges for the arbitrage (refillCex): ETN wallet -> HTX and USDT HTX -> KuCoin.
    // ETN_BOT_CEX_REFILL=true, live mode, HTX key set (Withdraw on it, KuCoin's BEP20 USDT deposit address in
    // HTX's address book). HTX's ETN target is held under its sweep float, or the sweep would send it back.
    cexRefill: process.env.ETN_BOT_CEX_REFILL === "true" && process.env.ETN_BOT_MODE === "live" && htxConfigured(),
    cexRefillEveryMs: num("ETN_BOT_CEX_REFILL_EVERY_MIN", 5) * 60000,
    refill: {
      htxEtnLow: num("ETN_BOT_REFILL_HTX_ETN_LOW", REFILL_DEFAULTS.htxEtnLow),
      htxEtnTarget: Math.min(num("ETN_BOT_REFILL_HTX_ETN_TARGET", REFILL_DEFAULTS.htxEtnTarget), num("ETN_BOT_HTX_ETN_FLOAT", SWEEP_DEFAULTS.htx.float)),
      walletKeepEtn: num("ETN_BOT_REFILL_WALLET_KEEP_ETN", REFILL_DEFAULTS.walletKeepEtn),
      minEtn: num("ETN_BOT_REFILL_MIN_ETN", REFILL_DEFAULTS.minEtn),
      kucoinUsdtLow: num("ETN_BOT_REFILL_KUCOIN_USDT_LOW", REFILL_DEFAULTS.kucoinUsdtLow),
      kucoinUsdtTarget: num("ETN_BOT_REFILL_KUCOIN_USDT_TARGET", REFILL_DEFAULTS.kucoinUsdtTarget),
      htxUsdtKeep: num("ETN_BOT_REFILL_HTX_USDT_KEEP", REFILL_DEFAULTS.htxUsdtKeep),
      minUsdt: num("ETN_BOT_REFILL_MIN_USDT", REFILL_DEFAULTS.minUsdt),
      // the USDT network: HTX's chain id and KuCoin's for the same chain (BEP20: 0.01 USDT fee on HTX)
      usdtHtxChain: process.env.ETN_BOT_REFILL_USDT_HTX_CHAIN || "bep20usdt",
      usdtKucoinChain: process.env.ETN_BOT_REFILL_USDT_KUCOIN_CHAIN || "bsc",
    },
    arbPaper: process.env.ETN_BOT_CEX_ARB_PAPER !== "false",
    arbLive: process.env.ETN_BOT_CEX_ARB_LIVE === "true" && process.env.ETN_BOT_MODE === "live" && kucoinConfigured() && htxConfigured(),
    arb: {
      ...ARB_DEFAULTS,
      minEdgePct: num("ETN_BOT_CEX_ARB_MIN_EDGE_PCT", ARB_DEFAULTS.minEdgePct),
      sizesUsd: ARB_DEFAULTS.sizesUsd.filter((u) => u <= num("ETN_BOT_CEX_ARB_MAX_USD", 90)),
      maxTradesPerDay: num("ETN_BOT_CEX_ARB_MAX_TRADES_PER_DAY", ARB_DEFAULTS.maxTradesPerDay),
      maxUsdPerDay: num("ETN_BOT_CEX_ARB_MAX_USD_PER_DAY", ARB_DEFAULTS.maxUsdPerDay),
    },
    rebalance: {
      ...REBALANCE_DEFAULTS,
      etnHigh: num("ETN_BOT_HEDGE_KC_ETN_HIGH", REBALANCE_DEFAULTS.etnHigh),
      etnTarget: num("ETN_BOT_HEDGE_KC_ETN_TARGET", REBALANCE_DEFAULTS.etnTarget),
      etnLow: num("ETN_BOT_HEDGE_KC_ETN_LOW", REBALANCE_DEFAULTS.etnLow),
      usdtLow: num("ETN_BOT_HEDGE_KC_USDT_LOW", REBALANCE_DEFAULTS.usdtLow),
    },
  };
}

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const poolIface = new ethers.Interface(POOL_ABI);
// Triangles: QuoterV2 multi-hop quotes, and WETN's Withdrawal event (the router unwrapping the loop's
// final WETN to native ETN for us) is how a filled loop's ETN out is read from its receipt.
const QUOTER_PATH_ABI = ["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"];
const WETN_IFACE = new ethers.Interface(["event Withdrawal(address indexed src, uint256 wad)"]);
// KuCoin catch-up: how much ETN it takes to get a lot's dollars back (exact output), and KuCoin's live book.
const QUOTER_OUT_ABI = ["function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"];
const KUCOIN_LEVEL1_URL = "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=ETN-USDT";
const KUCOIN_DEPTH_URL = "https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=ETN-USDT";
// A V3 multi-hop path: token, fee, token, fee, ..., token (any number of hops).
const triPath = (route) =>
  ethers.solidityPacked(
    route.tokens.flatMap((_, i) => (i === 0 ? ["address"] : ["uint24", "address"])),
    route.tokens.flatMap((t, i) => (i === 0 ? [t] : [TRIANGLE_FEE, t]))
  );
const routerIface = new ethers.Interface(ROUTER_ABI);

const fmtEtn = (n) => Math.round(n).toLocaleString("en-US");
const fmtUsd = (n) => `$${n.toFixed(2)}`;
const signedEtn = (n) => `${n >= 0 ? "+" : "−"}${fmtEtn(Math.abs(n))}`;

/** USD per ETN from a pool's slot0 (WETN = token0, 18 decimals; stablecoin = token1). */
async function midPrice(provider, p) {
  const { sqrtPriceX96 } = await new ethers.Contract(p.pool, POOL_ABI, provider).slot0();
  return (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (18 - p.decimals);
}

async function quote(provider, tokenIn, tokenOut, fee, amountInRaw) {
  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
  const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0 });
  return r.amountOut;
}

/** Live quotes the strategy needs: a clip sold into each pool, and each open lot bought back. */
export async function gatherQuotes(provider, state, clipEtn) {
  const clipRaw = ethers.parseEther(String(clipEtn));
  const sell = await Promise.all(
    Object.entries(POOLS).map(async ([stable, p]) => {
      try {
        const out = await quote(provider, WETN, p.token, p.fee, clipRaw);
        return { stable, stableOut: Number(ethers.formatUnits(out, p.decimals)) };
      } catch {
        return { stable, stableOut: 0 };
      }
    })
  );
  const buyback = {};
  for (const lot of state.lots.filter((l) => l.status === "open")) {
    const p = POOLS[lot.stable];
    try {
      buyback[lot.id] = Number(ethers.formatEther(await quote(provider, p.token, WETN, p.fee, ethers.parseUnits(lot.stableAmount.toFixed(p.decimals), p.decimals))));
    } catch {
      // unquotable this tick — the lot just isn't eligible
    }
  }
  return { sell, buyback };
}

function freshState(cfg) {
  return { budgetEtn: cfg.budgetEtn, realizedGainEtn: 0, lots: [], ema: null, emaAt: null, samples: 0, nextLotId: 1, pending: null, tradesByDay: {}, startedAt: new Date().toISOString() };
}

/** Reads the Swap event of `poolAddress` out of a receipt: { etnDelta, stableDelta } in human units,
 * signed from the pool's side (positive = paid into the pool by us, negative = paid out to us). */
function swapAmounts(receipt, p) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== p.pool.toLowerCase()) continue;
    try {
      const ev = poolIface.parseLog(log);
      if (ev?.name === "Swap") return { etnDelta: Number(ethers.formatEther(ev.args.amount0)), stableDelta: Number(ethers.formatUnits(ev.args.amount1, p.decimals)) };
    } catch {
      // not the Swap event
    }
  }
  return null;
}

// Stablecoin amounts are floats in the books; round DOWN to the token's decimals before spending, so
// rounding can never ask for one unit more than the wallet holds.
const floorTo = (n, decimals) => (Math.floor(n * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
const other = (stable) => (stable === "USDT" ? "USDC" : "USDT");

// `store` is swappable for tests (in-memory books); the bot itself always uses R2.
const DEFAULT_STORE = { get: getBotState, set: setBotState, claimLease: claimBotLease, releaseLease: releaseBotLease };
const DEFAULT_ALERT = { viewers: botViewers, chatIdFor: getNotisLinkedChatId, send: sendNotisDirectMessage };

export function createEtnAccumulatorBot({ provider, wallet, cfg, store = DEFAULT_STORE, owner = `${process.env.RENDER_INSTANCE_ID || os.hostname()}:${process.pid}`, alert = DEFAULT_ALERT }) {
  async function saveWithRetry(state) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.set(cfg.mode, state);
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  let running = false;
  let consecutiveFailures = 0;
  // Of those, how many were real — a sent tx that reverted, or a send that errored. A run of failures that
  // were ALL rejected in simulation (nothing sent, no gas: a fast-moving pool beat the slippage floor)
  // pauses only for cfg.simPauseMs and then resumes by itself; any real one needs a restart.
  let realFailures = 0;
  let pausedUntil = null;
  // What the last full check saw and whether it traded — the fast watcher compares against this.
  let lastTick = null;
  let actedThisTick = false;
  let fastWakes = 0;
  let pausedReason = null;
  // Shutdown (stop()): no new ticks start; the lease is released once the running one ends.
  let stopped = false;
  let leaseHolderLogged = null;
  // Fills and problems go to the Render logs only (no Telegram, by request).
  function notify(text) {
    console.log(`🤖 ETN bot${cfg.mode === "paper" ? " (paper)" : ""}: ${text}`);
  }

  const quoteSellEtn = async (stable, etn) => {
    const p = POOLS[stable];
    return Number(ethers.formatUnits(await quote(provider, WETN, p.token, p.fee, ethers.parseEther(etn.toFixed(18))), p.decimals));
  };
  const quoteBuyEtn = async (stable, usd) => {
    const p = POOLS[stable];
    return Number(ethers.formatEther(await quote(provider, p.token, WETN, p.fee, ethers.parseUnits(floorTo(usd, p.decimals), p.decimals))));
  };

  /** Marks a pre-send simulation that reverted, so it's told apart from a real failure. */
  const simulated = (p) =>
    p.catch((err) => {
      err.simulated = true;
      throw err;
    });

  /** Sends one swap — "sellEtn" (native ETN -> stablecoin) or "buyEtn" (stablecoin -> native ETN) —
   * after simulating it. Amounts are human units; minimum out = expectedOut less the slippage. */
  async function sendSwap(side, stable, amountIn, expectedOut) {
    const p = POOLS[stable];
    const router = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const slip = BigInt(10000 - cfg.slippageBps);
    if (side === "sellEtn") {
      const inRaw = ethers.parseEther(amountIn.toFixed(18));
      const minOut = (ethers.parseUnits(floorTo(expectedOut, p.decimals), p.decimals) * slip) / 10000n;
      const calls = [
        routerIface.encodeFunctionData("exactInputSingle", [{ tokenIn: WETN, tokenOut: p.token, fee: p.fee, recipient: wallet.address, amountIn: inRaw, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]),
        routerIface.encodeFunctionData("refundETH", []),
      ];
      await simulated(router.multicall.staticCall(deadline, calls, { value: inRaw }));
      return router.multicall(deadline, calls, { value: inRaw });
    }
    const inRaw = ethers.parseUnits(floorTo(amountIn, p.decimals), p.decimals);
    const minOut = (ethers.parseEther(expectedOut.toFixed(18)) * slip) / 10000n;
    const token = new ethers.Contract(p.token, ERC20_ABI, wallet);
    const held = await token.balanceOf(wallet.address);
    if (held < inRaw) throw new Error(`wallet holds ${ethers.formatUnits(held, p.decimals)} ${stable}, needs ${floorTo(amountIn, p.decimals)}`);
    if ((await token.allowance(wallet.address, SWAP_ROUTER)) < inRaw) {
      await (await token.approve(SWAP_ROUTER, inRaw)).wait(); // exact amount, never unlimited
    }
    const calls = [
      routerIface.encodeFunctionData("exactInputSingle", [{ tokenIn: p.token, tokenOut: WETN, fee: p.fee, recipient: ADDRESS_THIS, amountIn: inRaw, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]),
      routerIface.encodeFunctionData("unwrapWETH9", [minOut, wallet.address]),
    ];
    await simulated(router.multicall.staticCall(deadline, calls));
    return router.multicall(deadline, calls);
  }

  /** Books a filled order — `amounts` from the pool's Swap event (live) or the quote (paper). */
  function settleFill(state, order, amounts, txHash) {
    const at = new Date().toISOString();
    const etnIn = amounts.etnDelta, stableOut = -amounts.stableDelta; // for sells
    const etnOut = -amounts.etnDelta, stableIn = amounts.stableDelta; // for buys
    const gap = state.gap;
    switch (order.kind) {
      case "sell": {
        applySell(state, { id: order.lotId, stable: order.stable, etnSold: etnIn, stableAmount: stableOut, txHash, at });
        notify(`🔴 Sold ${fmtEtn(etnIn)} ETN for ${fmtUsd(stableOut)} ${order.stable} at ${(stableOut / etnIn).toPrecision(4)} (lot #${order.lotId}, EMA ${state.ema?.toPrecision(4)})`);
        break;
      }
      case "buyback": {
        const lot = state.lots.find((l) => l.id === order.lotId);
        applyBuyback(state, order.lotId, { etnBought: etnOut, txHash, at });
        notify(`🟢 Bought back ${fmtEtn(etnOut)} ETN for ${fmtUsd(lot.stableAmount)} ${lot.stable} — ${signedEtn(etnOut - lot.etnSold)} ETN (lot #${lot.id}). Realized so far: ${signedEtn(state.realizedGainEtn)} ETN`);
        break;
      }
      case "seed": {
        gap.seedEtn += etnIn;
        gap.stables[order.stable] += stableOut;
        gap.seeded[order.stable] = true;
        notify(`🌱 Gap book seeded: sold ${fmtEtn(etnIn)} ETN for ${fmtUsd(stableOut)} ${order.stable}`);
        break;
      }
      case "gapSell": {
        applyGapSellLeg(gap, { dear: order.stable, stableReceived: stableOut });
        state.gapLeg = { dear: order.stable, cheap: order.cheap, etnSold: etnIn, stableReceived: stableOut, sellTx: txHash, at };
        break;
      }
      case "gapBuy": {
        const leg = state.gapLeg;
        applyGapBuyLeg(gap, { dear: leg.dear, cheap: order.stable, etnSold: leg.etnSold, stableReceived: leg.stableReceived, stableSpent: stableIn, etnBought: etnOut, at, txHashes: [leg.sellTx, txHash] });
        state.gapLeg = null;
        notify(`🔁 Gap trade: sold ${fmtEtn(leg.etnSold)} ETN for ${fmtUsd(leg.stableReceived)} ${leg.dear}, bought ${fmtEtn(etnOut)} ETN with ${fmtUsd(stableIn)} ${order.stable} — ${signedEtn(etnOut - leg.etnSold)} ETN. Gap total: ${signedEtn(gap.gainEtn)} ETN over ${gap.trades} trade(s)`);
        break;
      }
      case "cuBuy": {
        applyCatchupBuy(state.cu, { stable: order.stable, usdSpent: stableIn, etnBought: etnOut, at, txHash, lagPct: order.lagPct });
        notify(`📥 Catch-up buy: ElectroSwap ${Math.abs(order.lagPct).toFixed(1)}% below KuCoin — ${fmtUsd(stableIn)} ${order.stable} -> ${fmtEtn(etnOut)} ETN (lot #${state.cu.nextId - 1}; pot ${fmtUsd(state.cu.cash.USDT)} USDT / ${fmtUsd(state.cu.cash.USDC)} USDC)`);
        break;
      }
      case "cuSell": {
        const lot = state.cu.lots.find((l) => l.id === order.lotId);
        applyCatchupClose(state.cu, order.lotId, { etnSold: etnIn, usdReceived: stableOut, at, txHash });
        notify(`📤 Catch-up close: sold ${fmtEtn(etnIn)} ETN for ${fmtUsd(stableOut)} ${order.stable}, kept ${signedEtn(lot.etn - etnIn)} ETN (lot #${lot.id}). Catch-up total: ${signedEtn(state.cu.gainEtn)} ETN over ${state.cu.closed}`);
        break;
      }
      case "cuSellFirst": {
        applyCatchupSell(state.cu, { stable: order.stable, etnSold: etnIn, usdReceived: stableOut, at, txHash, lagPct: order.lagPct });
        notify(`📤 Catch-up sell: ElectroSwap ${order.lagPct.toFixed(1)}% above KuCoin — sold ${fmtEtn(etnIn)} ETN for ${fmtUsd(stableOut)} ${order.stable} (lot #${state.cu.nextId - 1}; ${fmtEtn(openSellEtn(state.cu))} ETN out on the sell side)`);
        break;
      }
      case "cuBuyBack": {
        const lot = state.cu.lots.find((l) => l.id === order.lotId);
        applyCatchupBuyBack(state.cu, order.lotId, { usdSpent: stableIn, etnBought: etnOut, at, txHash });
        notify(`📥 Catch-up buy-back: ${fmtUsd(stableIn)} ${order.stable} -> ${fmtEtn(etnOut)} ETN, ${signedEtn(etnOut - lot.etn)} ETN vs the ${fmtEtn(lot.etn)} sold (lot #${lot.id}). Catch-up total: ${signedEtn(state.cu.gainEtn)} ETN over ${state.cu.closed}`);
        break;
      }
      case "hedgeSellEs":
      case "hedgeBuyEs": {
        // ElectroSwap leg filled; the KuCoin leg runs next (completeHedgeLeg) — kept in state until it does.
        const sellOnEs = order.kind === "hedgeSellEs";
        state.hedgeLeg = {
          dir: sellOnEs ? "sellOnEs" : "buyOnEs",
          stable: order.stable,
          esEtn: sellOnEs ? etnIn : etnOut,
          esUsd: sellOnEs ? stableOut : stableIn,
          lagPct: order.lagPct,
          venue: order.venue || "kucoin",
          txHash,
          at,
          clientOid: `etnbot-${(txHash || "0x" + Date.now()).slice(2, 20)}`,
        };
        break;
      }
      case "triangle": {
        state.tri = state.tri || freshTriangleBook();
        applyTriangleTrade(state.tri, { route: order.route, etnIn: order.amountIn, etnOut: amounts.etnOut, txHash, at });
        notify(`🔺 Triangle ${order.route}: ${fmtEtn(order.amountIn)} ETN in, ${fmtEtn(amounts.etnOut)} out — ${signedEtn(amounts.etnOut - order.amountIn)} ETN. Triangle total: ${signedEtn(state.tri.gainEtn)} ETN over ${state.tri.trades} trade(s)`);
        break;
      }
      default:
        throw new Error(`Unknown order kind ${order.kind}`);
    }
  }

  /** Settles state.pending from its receipt: "filled" | "failed" | "waiting". */
  async function resolvePending(state) {
    const pending = state.pending;
    const receipt = await provider.getTransactionReceipt(pending.txHash);
    if (!receipt) {
      // Dropped for certain only once the wallet's mined nonce has moved past this tx's own (a
      // timeout alone could clear a sale that still mines later, losing track of its stablecoin).
      const minedNonce = await provider.getTransactionCount(wallet.address, "latest");
      if (pending.nonce != null && minedNonce > pending.nonce) {
        if (await provider.getTransactionReceipt(pending.txHash)) return resolvePending(state);
        state.pending = null;
        notify(`⚠️ ${pending.kind} tx ${pending.txHash} was dropped (nonce ${pending.nonce} used by another tx); cleared.`);
        return "failed";
      }
      return "waiting";
    }
    if (receipt.status !== 1) {
      state.pending = null;
      consecutiveFailures++;
      realFailures++;
      notify(`❌ ${pending.kind} tx ${pending.txHash} reverted.`);
      return "failed";
    }
    const amounts = pending.kind === "triangle" ? triangleAmounts(receipt) : swapAmounts(receipt, POOLS[pending.stable]);
    if (!amounts) throw new Error(`No Swap event in ${pending.txHash}`); // left pending — needs a look, not a guess
    state.pending = null;
    consecutiveFailures = 0;
    realFailures = 0;
    settleFill(state, pending, amounts, pending.txHash);
    return "filled";
  }

  /** A triangle loop as ONE transaction: exactInput over the 3-hop path into the router, then unwrap
   * to native ETN for us — with a minimum out above the ETN put in (triangleMinOut), so it either
   * ends with more ETN or reverts. Simulated first. */
  async function sendTriangle(order) {
    const route = TRIANGLE_ROUTES.find((r) => r.name === order.route);
    const amountIn = ethers.parseEther(order.amountIn.toFixed(18));
    const minOut = ethers.parseEther(triangleMinOut(order.amountIn, order.expectedOut).toFixed(18));
    const router = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
    const calls = [
      routerIface.encodeFunctionData("exactInput", [{ path: triPath(route), recipient: ADDRESS_THIS, amountIn, amountOutMinimum: minOut }]),
      routerIface.encodeFunctionData("unwrapWETH9", [minOut, wallet.address]),
    ];
    const deadline = Math.floor(Date.now() / 1000) + 300;
    await simulated(router.multicall.staticCall(deadline, calls, { value: amountIn }));
    return router.multicall(deadline, calls, { value: amountIn });
  }

  /** ETN a filled triangle returned: WETN's Withdrawal by the router (the final unwrap). */
  function triangleAmounts(receipt) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== WETN.toLowerCase()) continue;
      try {
        const ev = WETN_IFACE.parseLog(log);
        if (ev?.name === "Withdrawal" && ev.args.src.toLowerCase() === SWAP_ROUTER.toLowerCase()) return { etnOut: Number(ethers.formatEther(ev.args.wad)) };
      } catch {
        // not the Withdrawal event
      }
    }
    return null;
  }

  /** Live triangle quotes. A cheap pre-screen first (the five pools' slot0): only a route whose mid-price
   * loop beats the ~0.9% of fees gets real QuoterV2 figures, at each size up to triMaxEtn. */
  async function triangleQuotes() {
    const sqrtPrices = {};
    for (const [k, info] of Object.entries(TRIANGLE_POOLS)) {
      try {
        sqrtPrices[k] = (await new ethers.Contract(info.pool, POOL_ABI, provider).slot0()).sqrtPriceX96;
      } catch {
        // unreadable this tick — routes through it are skipped
      }
    }
    const edges = routeEdges(sqrtPrices);
    const quoter = new ethers.Contract(QUOTER, QUOTER_PATH_ABI, provider);
    const quotes = [];
    for (const e of edges.filter((x) => x.edgePct != null)) {
      const route = TRIANGLE_ROUTES.find((r) => r.name === e.name);
      if (e.edgePct <= prescreenEdgePct(route)) continue;
      for (const etnIn of TRIANGLE_DEFAULTS.sizesEtn.filter((s) => s <= cfg.triMaxEtn)) {
        try {
          const r = await quoter.quoteExactInput.staticCall(triPath(route), ethers.parseEther(String(etnIn)));
          quotes.push({ route: route.name, etnIn, etnOut: Number(ethers.formatEther(r.amountOut)) });
        } catch {
          // this size can't be filled — skip
        }
      }
    }
    const best = edges.filter((x) => x.edgePct != null).reduce((a, x) => (!a || x.edgePct > a.edgePct ? x : a), null);
    return { quotes, best, sqrtKey: Object.values(sqrtPrices).map(String).join("|") };
  }

  /** Paper: fills at the quote. Live: sends, records it as pending, waits, settles. */
  async function execute(state, order) {
    actedThisTick = true;
    if (cfg.mode === "paper") {
      const amounts = order.kind === "triangle" ? { etnOut: order.expectedOut } : order.side === "sellEtn" ? { etnDelta: order.amountIn, stableDelta: -order.expectedOut } : { etnDelta: -order.expectedOut, stableDelta: order.amountIn };
      settleFill(state, order, amounts, null);
      return "filled";
    }
    let tx;
    try {
      tx = order.kind === "triangle" ? await sendTriangle(order) : await sendSwap(order.side, order.stable, order.amountIn, order.expectedOut);
    } catch (err) {
      consecutiveFailures++;
      if (!err.simulated) realFailures++;
      throw err;
    }
    state.pending = { ...order, txHash: tx.hash, nonce: tx.nonce, sentAt: new Date().toISOString() };
    await saveWithRetry(state); // record the in-flight tx before waiting on it — a lost write here would lose the trade
    await provider.waitForTransaction(tx.hash, 1, 120000).catch(() => null);
    const result = await resolvePending(state);
    await saveWithRetry(state);
    return result;
  }

  /** The second leg of a gap trade: spend the cheap pool's stablecoin on ETN. Always completed (even
   * if the gap has since closed) so the ETN sold in the first leg comes back. */
  async function completeGapLeg(state) {
    const leg = state.gapLeg;
    const amountIn = Math.min(leg.stableReceived, state.gap.stables[leg.cheap] || 0);
    if (!(amountIn > 0.01)) {
      // Nothing to buy with (shouldn't happen — the trade was sized to the book). Fold the first leg
      // into the seed so the books stay whole, and move on.
      state.gap.seedEtn += leg.etnSold;
      state.gapLeg = null;
      notify(`⚠️ Gap trade second leg skipped: no ${leg.cheap} left in the gap book; first leg kept as ${leg.dear}.`);
      return "failed";
    }
    const expectedOut = await quoteBuyEtn(leg.cheap, amountIn);
    return execute(state, { kind: "gapBuy", side: "buyEtn", stable: leg.cheap, amountIn, expectedOut });
  }

  /** Brings the gap book in line with the wallet's actual USDT/USDC. Everything the bot does is in its
   * books, so the wallet should hold exactly the gap book plus any open lots' stablecoin; a surplus can
   * only be a top-up sent to the wallet, and joins the gap book as a deposit — counted at that moment's
   * ETN value, so the ETN-vs-holding figure isn't flattered by it. A shortfall (stablecoin moved out of
   * the wallet by hand) shrinks the book to match, so the bot never plans a trade it can't pay for.
   * Only runs between trades: the caller has already settled anything pending. */
  async function reconcileGapStables(state, mids) {
    // The wallet's USDT/USDC should be exactly: open sell/buyback lots + the gap book + the catch-up pot's
    // cash. A surplus is a deposit: it fills the catch-up pot up to its target first (that's how the pot
    // is funded), then joins the gap book. A shortfall comes off the gap book, then the pot.
    const gap = state.gap;
    const cu = cfg.cuEnabled ? state.cu : null;
    for (const [k, p] of Object.entries(POOLS)) {
      const held = Number(ethers.formatUnits(await new ethers.Contract(p.token, ERC20_ABI, provider).balanceOf(wallet.address), p.decimals));
      const inLots = state.lots.filter((l) => l.status === "open" && l.stable === k).reduce((s, l) => s + l.stableAmount, 0);
      // Live hedging's dollars are the wallet's too: its book, plus an unfinished leg (ElectroSwap done,
      // KuCoin not yet — a sell leg added dollars, a buy leg spent them).
      const leg = state.hedgeLeg?.stable === k ? state.hedgeLeg : null;
      const hedgeUsd = (state.hedgeLive?.stables?.[k] || 0) + (leg ? (leg.dir === "sellOnEs" ? leg.esUsd : -leg.esUsd) : 0);
      const diff = held - inLots - (gap?.stables[k] || 0) - (state.cu?.cash[k] || 0) - openSellUsd(state.cu, k) - hedgeUsd;
      if (Math.abs(diff) < 0.01) continue;
      if (diff > 0) {
        const { toCatchup, rest } = splitDeposit(cu, k, diff);
        if (toCatchup > 0) {
          applyCatchupFunding(cu, k, toCatchup, toCatchup / mids[k]);
          notify(`💵 ${fmtUsd(toCatchup)} ${k} found in the wallet — added to the KuCoin catch-up pot (now ${fmtUsd(cu.cash.USDT)} USDT / ${fmtUsd(cu.cash.USDC)} USDC of a ${fmtUsd(cu.target)} target)`);
        }
        if (rest >= 0.01 && gap) {
          applyGapDeposit(gap, k, rest, rest / mids[k]);
          notify(`💵 ${fmtUsd(rest)} ${k} found in the wallet — added to the gap book (now ${fmtUsd(gap.stables[k])} ${k})`);
        } else if (rest >= 0.01) {
          notify(`ℹ️ ${fmtUsd(rest)} ${k} in the wallet isn't assigned to any mode (gap mode is off and the catch-up pot is full)`);
        }
      } else {
        let short = -diff;
        if (gap) {
          const before = gap.stables[k] || 0;
          applyGapDeposit(gap, k, -short, -short / mids[k]);
          short -= before - (gap.stables[k] || 0);
        }
        if (short >= 0.01 && state.cu) state.cu.cash[k] = Math.max(0, (state.cu.cash[k] || 0) - short);
        notify(`⚠️ ${fmtUsd(-diff)} ${k} missing from the wallet — books reduced to match`);
      }
    }
  }

  /** KuCoin's live ETN-USDT mid (null when unavailable or its book looks too thin to trust). */
  async function kucoinPrice() {
    try {
      const res = await fetch(KUCOIN_LEVEL1_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return kucoinMid((await res.json())?.data, CATCHUP_DEFAULTS.maxSpreadPct);
    } catch {
      return null;
    }
  }

  /** KuCoin's top-20 order book { bids, asks } (best first), or null. */
  async function kucoinBook() {
    try {
      const res = await fetch(KUCOIN_DEPTH_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const d = (await res.json())?.data;
      return d?.bids?.length && d?.asks?.length ? { bids: d.bids, asks: d.asks } : null;
    } catch {
      return null;
    }
  }

  let symbolRules = null;
  const nowMs = () => Date.now();
  // A pause of live hedging is saved with the books (so the next check doesn't carry on); a restart of
  // the service is the "I've sorted KuCoin out" signal, so the first check after one lifts it.
  let hedgePauseCheckedSinceStart = false;
  let lastRebalanceAt = 0;
  let lastSweepAt = 0;
  // A venue whose key can't withdraw (e.g. KuCoin drops Withdraw from a key without an IP restriction):
  // its sweep stops until the next restart instead of failing every run. venue -> reason
  const sweepOff = new Map();

  /** Brings each exchange's ETN above its float back to the bot wallet (SWEEP_DEFAULTS / ETN_BOT_*_ETN_FLOAT)
   * — the ETN hedges and the arbitrage gain lands on the exchanges. At most one withdrawal per run, always
   * to the bot's own wallet, never while a hedge or arbitrage leg is unfinished. Returns true if it moved
   * something. */
  async function sweepExcessEtn(state) {
    if (!wallet || state.hedgeLeg || state.arbLeg) return false;
    state.cexSweep = state.cexSweep || {};
    for (const venue of ["htx", "kucoin"]) {
      const v = VENUES[venue];
      if (!v.configured() || sweepOff.has(venue)) continue;
      const have = (await v.balances().catch(() => null))?.ETN;
      if (!(have > 0)) continue;
      const rules = venue === "kucoin" ? await getWithdrawRules("ETN", "etnevm") : await htxWithdrawRules("ETN", "etn1");
      if (!rules.enabled) continue;
      const amount = sweepAmount(have, cfg.sweep[venue], rules.min);
      if (!amount) continue;
      try {
        if (venue === "kucoin") {
          // withdrawals leave from KuCoin's Main account; the fee comes out on top
          const moved = Math.ceil(amount + rules.fee);
          await innerTransfer({ currency: "ETN", from: "trade", to: "main", amount: moved, clientOid: `etnbot-sw-${Date.now()}` });
          try {
            noteBotWithdrawal(state, await withdraw({ currency: "ETN", address: wallet.address, amount, chain: "etnevm" }));
          } catch (err) {
            // Never leave it stranded in Main (where trading can't reach it): straight back to Trade.
            await innerTransfer({ currency: "ETN", from: "main", to: "trade", amount: moved, clientOid: `etnbot-sw-back-${Date.now()}` }).catch((e) =>
              notify(`⚠️ Sweep: couldn't move ${fmtEtn(moved)} ETN back to KuCoin's trading account (${e.message}) — it's in Main; move it in the KuCoin app`)
            );
            throw err;
          }
        } else {
          await htxWithdraw({ currency: "ETN", address: wallet.address, amount, chain: "etn1", fee: rules.fee });
        }
      } catch (err) {
        if (/400007|permission|withdraw.*(not|disabled)|api-not-support|forbidden/i.test(err.message)) {
          sweepOff.set(venue, err.message);
          notify(`⏸️ Sweep off for ${v.name} until the next restart — its key can't withdraw (${err.message}). Give the key Withdraw permission (${venue === "kucoin" ? "KuCoin only allows that with an IP restriction" : "with its IP binding"}), or withdraw by hand.`);
          continue;
        }
        throw err;
      }
      const rec = (state.cexSweep[venue] = state.cexSweep[venue] || { count: 0, etn: 0, feesEtn: 0, last: null });
      rec.count += 1;
      rec.etn += amount;
      rec.feesEtn += rules.fee;
      rec.last = new Date().toISOString();
      // ETN the refill sent to HTX coming back isn't the hedges' — only the rest counts for them.
      const er = venue === "htx" ? state.cexRefill?.etn : null;
      const refillBack = er ? Math.min(amount, er.netOut || 0) : 0;
      if (er) er.netOut -= refillBack;
      const hb = state.hedgeLive;
      if (hb) {
        hb.walletEtnNet += amount - refillBack;
        hb.costsEtn = (hb.costsEtn || 0) + rules.fee;
        if (venue === "kucoin") hb.kucoinEtnNet -= amount + rules.fee;
      }
      notify(`🏠 Swept ${fmtEtn(amount)} ETN from ${v.name} back to the bot wallet (kept ${fmtEtn(cfg.sweep[venue].float)} there; fee ${rules.fee} ETN)`);
      actedThisTick = true;
      return true;
    }
    return false;
  }

  let lastRefillAt = 0;
  // A refill whose HTX side can't be done (no Withdraw on the key, KuCoin's address not in HTX's address
  // book): off until the next restart instead of failing every run. kind ("etn"/"usdt") -> reason
  const refillOff = new Map();
  const REFILL_STUCK_MS = 6 * 3600000; // a transfer not seen arriving by then is dropped (with a warning)
  const sameTx = (a, b) => String(a || "").toLowerCase().replace(/^0x/, "") === String(b || "").toLowerCase().replace(/^0x/, "");

  /** Keeps the arbitrage stocked (see REFILL_DEFAULTS): sends the wallet's ETN to HTX when HTX runs low,
   * and withdraws HTX's USDT to KuCoin when KuCoin runs low. One transfer of each kind in flight; settling
   * one that's arrived counts as this run's action. ETN goes only to HTX's own deposit address, USDT only
   * to KuCoin's (and HTX only withdraws to addresses in its address book). Returns true if state changed. */
  async function refillCex(state) {
    if (!wallet || state.hedgeLeg || state.arbLeg) return false;
    const r = (state.cexRefill = state.cexRefill || {});
    const er = (r.etn = r.etn || { count: 0, etn: 0, gasEtn: 0, netOut: 0, last: null, pending: null });
    const ur = (r.usdt = r.usdt || { count: 0, usd: 0, feesUsd: 0, last: null, pending: null });
    const age = (p) => Date.now() - Date.parse(p.at);

    // ETN on its way to HTX: arrived (HTX's deposit record for the tx), orphaned, or lost track of.
    if (er.pending) {
      const p = er.pending;
      const dep = (await htxTransfers("ETN", "deposit")).find((d) => sameTx(d.txHash, p.tx));
      if (dep && (dep.state === "safe" || dep.state === "confirmed")) {
        notify(`📥 Refill: ${fmtEtn(p.etn)} ETN arrived on HTX`);
        er.pending = null;
        return true;
      }
      if (dep?.state === "orphan" || age(p) > REFILL_STUCK_MS) {
        notify(`⚠️ Refill: ${fmtEtn(p.etn)} ETN sent to HTX (tx ${p.tx}) ${dep ? `is "${dep.state}" there` : "hasn't shown up on HTX after 6h"} — check HTX's deposit history`);
        er.pending = null;
        return true;
      }
    }

    // USDT on its way to KuCoin: refused by HTX, or arrived in KuCoin's Main account -> into Trade.
    if (ur.pending && kucoinConfigured()) {
      const p = ur.pending;
      const wd = (await htxTransfers("USDT", "withdraw")).find((w) => String(w.id) === String(p.id));
      if (wd && /cancel|reject|error|repeal/.test(wd.state)) {
        notify(`⚠️ Refill: HTX's ${fmtUsd(p.usd)} USDT withdrawal to KuCoin was "${wd.state}" — nothing sent`);
        ur.pending = null;
        return true;
      }
      const main = await getBalances("main");
      if (main.USDT >= 1) {
        const amount = floorToIncrement(Math.min(main.USDT, p.usd), 0.000001);
        await innerTransfer({ currency: "USDT", from: "main", to: "trade", amount, clientOid: `etnbot-rf-t-${Date.now()}` });
        p.usd = Math.max(0, p.usd - amount);
        notify(`📥 Refill: ${fmtUsd(amount)} USDT arrived on KuCoin, moved to its trading account`);
        if (p.usd < 1) ur.pending = null;
        return true;
      }
      if (age(p) > REFILL_STUCK_MS) {
        notify(`⚠️ Refill: ${fmtUsd(p.usd)} USDT withdrawn from HTX (id ${p.id}) hasn't reached KuCoin after 6h — check both exchanges' histories`);
        ur.pending = null;
        return true;
      }
    }

    const htx = await htxBalances();

    // ETN wallet -> HTX
    if (!er.pending && !refillOff.has("etn")) {
      const rules = await htxWithdrawRules("ETN", "etn1");
      const walletEtn = Number(ethers.formatEther(await provider.getBalance(wallet.address))) - cfg.gasReserveEtn;
      const lotEtn = (state.cu?.lots || []).filter((l) => l.kind !== "sellFirst").reduce((s, l) => s + l.etn, 0);
      const amount = rules.depositEnabled ? decideEtnRefill({ htxEtn: htx.ETN, walletEtn, lotEtn, depositMin: rules.depositMin }, cfg.refill) : 0;
      if (amount) {
        const dep = await htxDepositAddress("ETN", "etn1");
        if (!dep?.address || dep.tag || !ethers.isAddress(dep.address)) {
          refillOff.set("etn", "no usable HTX ETN deposit address");
          notify(`⏸️ Refill of HTX's ETN off until the next restart — HTX gave no plain ETN (etn1) deposit address${dep?.tag ? " (it wants a memo/tag)" : ""}`);
        } else {
          const tx = await wallet.sendTransaction({ to: dep.address, value: ethers.parseEther(String(amount)) });
          // Recorded as soon as it's broadcast: if the wait below fails, the deposit check still finds it.
          er.pending = { etn: amount, tx: tx.hash, at: new Date().toISOString() };
          er.count += 1;
          er.etn += amount;
          er.netOut += amount;
          er.last = er.pending.at;
          await saveWithRetry(state);
          const receipt = await tx.wait();
          er.gasEtn += Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n)));
          notify(`📤 Refill: sent ${fmtEtn(amount)} ETN to HTX (it had ${fmtEtn(htx.ETN)}; target ${fmtEtn(cfg.refill.htxEtnTarget)}) — tx ${tx.hash}`);
          actedThisTick = true;
          return true;
        }
      }
    }

    // USDT HTX -> KuCoin
    if (!ur.pending && !refillOff.has("usdt") && kucoinConfigured()) {
      const chain = cfg.refill.usdtHtxChain;
      const rules = await htxWithdrawRules("USDT", chain);
      const [trade, main] = await Promise.all([getBalances("trade"), getBalances("main")]);
      const amount = rules.enabled ? decideUsdtRefill({ kucoinUsdt: trade.USDT + main.USDT, htxUsdt: htx.USDT, fee: rules.fee, withdrawMin: rules.min }, cfg.refill) : 0;
      if (amount) {
        const dep = await getDepositAddress("USDT", cfg.refill.usdtKucoinChain);
        if (!dep?.address || dep.memo) {
          refillOff.set("usdt", "no KuCoin USDT deposit address");
          notify(`⏸️ Refill of KuCoin's USDT off until the next restart — ${dep?.memo ? "KuCoin's USDT deposit address needs a memo" : `create a USDT deposit address on ${cfg.refill.usdtKucoinChain.toUpperCase()} on KuCoin's Deposit page first`}`);
          return false;
        }
        let id;
        try {
          id = await htxWithdraw({ currency: "USDT", address: dep.address, amount, chain, fee: rules.fee });
        } catch (err) {
          if (/permission|address|api-not-support|forbidden|white/i.test(err.message)) {
            refillOff.set("usdt", err.message);
            notify(`⏸️ Refill of KuCoin's USDT off until the next restart — HTX refused the withdrawal (${err.message}). Add KuCoin's USDT ${cfg.refill.usdtKucoinChain.toUpperCase()} deposit address ${dep.address} to HTX's withdrawal address book (network ${chain}), then restart.`);
            return false;
          }
          throw err;
        }
        ur.pending = { usd: amount, id, at: new Date().toISOString() };
        ur.count += 1;
        ur.usd += amount;
        ur.feesUsd += rules.fee;
        ur.last = ur.pending.at;
        notify(`📤 Refill: withdrew ${fmtUsd(amount)} USDT from HTX to KuCoin (${chain}, fee ${rules.fee} USDT; KuCoin had ${fmtUsd(trade.USDT + main.USDT)}) — HTX id ${id}`);
        actedThisTick = true;
        return true;
      }
    }
    return false;
  }

  /** Remembers a KuCoin withdrawal the bot made itself, so bookManualWithdrawals doesn't count it again. */
  function noteBotWithdrawal(state, id) {
    if (!id) return;
    state.kcBotWithdrawals = [...(state.kcBotWithdrawals || []), String(id)].slice(-100);
  }

  /** Books ETN withdrawn from KuCoin to the bot wallet BY HAND (e.g. after a withdraw alert): its fee is a
   * cost of the CEX arbitrage (cexArb.costsEtn), and the ETN coming home first settles what live hedging
   * still had out on KuCoin (hedgeLive.walletEtnNet, which caps hedge sizes) — as the automatic sweep would.
   * Each withdrawal is booked once (by KuCoin's id); the bot's own are skipped. Returns true if state changed. */
  async function bookManualWithdrawals(state) {
    if (!wallet || !kucoinConfigured()) return false;
    const ab = state.cexArb || (state.cexArb = freshArbBook());
    const m = (ab.manual = ab.manual || { count: 0, etn: 0, feesEtn: 0, seen: [] });
    const since = Math.min(Date.parse(ab.since), Date.parse(state.hedgeLive?.since || ab.since));
    const rows = await getWithdrawals("ETN", Math.max(since, Date.now() - 7 * 86400000 + 3600000));
    const own = new Set(state.kcBotWithdrawals || []);
    let changed = false;
    for (const w of rows.sort((a, b) => a.createdAt - b.createdAt)) {
      if (w.createdAt < since || w.address.toLowerCase() !== wallet.address.toLowerCase() || own.has(w.id) || m.seen.includes(w.id)) continue;
      m.seen = [...m.seen, w.id].slice(-100);
      m.count += 1;
      m.etn += w.amount;
      m.feesEtn += w.fee;
      const hb = state.hedgeLive;
      const hedgeShare = hb ? Math.min(w.amount, Math.max(0, -hb.walletEtnNet)) : 0;
      // The fee is split by whose ETN came home: the hedges' share to them, the rest to the arbitrage.
      const hedgeFee = w.amount > 0 ? (w.fee * hedgeShare) / w.amount : 0;
      ab.costsEtn = (ab.costsEtn || 0) + w.fee - hedgeFee;
      if (hedgeShare > 0) {
        hb.walletEtnNet += hedgeShare;
        hb.kucoinEtnNet -= hedgeShare;
        hb.costsEtn = (hb.costsEtn || 0) + hedgeFee;
      }
      notify(`🧾 Booked a manual KuCoin withdrawal: ${fmtEtn(w.amount)} ETN to the bot wallet, fee ${fmtEtn(w.fee)} ETN (${fmtEtn(w.fee - hedgeFee)} to the CEX arbitrage${hedgeShare > 0 ? `, ${fmtEtn(hedgeFee)} to live hedging, whose ${fmtEtn(hedgeShare)} ETN on KuCoin it brings home` : ""})`);
      changed = true;
    }
    return changed;
  }

  /** Telegram-DMs the ETN Bot viewers (as the KuCoin withdraw alert does). */
  async function dmViewers(text) {
    for (const viewer of alert.viewers()) {
      const chatId = await alert.chatIdFor(viewer).catch(() => null);
      if (chatId != null) await alert.send(chatId, text).catch((err) => console.error(`⚠️  ETN bot: DM to ${viewer} failed:`, err.message));
    }
  }

  /** Works out the profit if every open lot closed now (profitNowEtn) and which side the floor blocks
   * (profitFloorBlocks: below it, only the losing side). Only changes on a fully quoted reading; announces
   * each change (logs + DM). Returns { buys, sells } — true = no new lots on that side. */
  async function checkProfitFloor(state, ladderBack) {
    const cuLots = state.cu?.lots || [];
    const cuBack = {};
    for (const l of cuLots.filter((x) => x.kind === "sellFirst")) cuBack[l.id] = await quoteBuyEtn(l.stable, l.usd).catch(() => 0);
    const cuNeed = cuLots.some((x) => x.kind !== "sellFirst") ? await catchupNeeds(state.cu) : {};
    const p = profitNowEtn(state, { ladderBack, cuBack, cuNeed });
    const pf = (state.profitFloor = state.profitFloor || { below: false, blockBuys: false, blockSells: false, since: null });
    pf.floorEtn = cfg.profitFloorEtn;
    pf.profitEtn = p.profitEtn;
    pf.openEtn = p.openEtn;
    pf.buyOpenEtn = p.buyOpenEtn;
    pf.sellOpenEtn = p.sellOpenEtn;
    pf.at = new Date().toISOString();
    const b = profitFloorBlocks(p, cfg.profitFloorEtn);
    if (p.allQuoted && (b.below !== pf.below || b.buys !== Boolean(pf.blockBuys) || b.sells !== Boolean(pf.blockSells))) {
      pf.below = b.below;
      pf.blockBuys = b.buys;
      pf.blockSells = b.sells;
      pf.since = pf.at;
      const blocked = b.buys && b.sells ? "No new lots on either side" : b.buys ? "No new BUY lots (catch-up buys) — the buy side is the one losing; sells (ladder, catch-up sells) carry on" : "No new SELL lots (ladder, catch-up sells) — the sell side is the one losing; catch-up buys carry on";
      const text = b.below
        ? `🛡️ *ETN Bot — under the profit floor*\n\nProfit is ${signedEtn(p.profitEtn)} ETN counting open positions (buy side ${signedEtn(p.buyOpenEtn)}, sell side ${signedEtn(p.sellOpenEtn)}), under the ${fmtEtn(cfg.profitFloorEtn)} ETN floor. ${blocked} until it's back above. Open lots still close, and gap/triangle/hedge/arbitrage round trips carry on.`
        : `✅ *ETN Bot — back above the profit floor*\n\nProfit is ${signedEtn(p.profitEtn)} ETN counting open positions (floor ${fmtEtn(cfg.profitFloorEtn)} ETN). New lots can open on both sides again.`;
      notify(text.replace(/\*/g, "").replace(/\n+/g, " "));
      await dmViewers(text);
    }
    // A floor state saved before the per-side split (below, no sides yet) blocks both until a quoted reading.
    return { buys: pf.blockBuys ?? Boolean(pf.below), sells: pf.blockSells ?? Boolean(pf.below) };
  }

  let lastWithdrawAlertCheckAt = 0;
  /** When the bot can't sweep KuCoin itself (its key has no Withdraw permission, or the sweep is off),
   * Telegram-DMs the ETN Bot viewers (botViewers, via the Core Tier Notis bot) how much ETN to withdraw
   * by hand: anything over the KuCoin float, once it's at least the sweep minimum. Once per amount — again
   * when it grows by half or after a day; it resets when the excess is gone. Returns true if state changed. */
  async function kucoinWithdrawAlert(state) {
    if (!wallet || !kucoinConfigured()) return false;
    if (cfg.cexSweep && !sweepOff.has("kucoin")) return false; // the sweep handles it
    const prev = state.kucoinWithdrawAlert || null;
    const [trade, main, rules] = await Promise.all([getTradeBalances(), getBalances("main"), getWithdrawRules("ETN", "etnevm")]);
    const have = (trade.ETN || 0) + (main.ETN || 0);
    const amount = Math.floor(sweepAmount(have, cfg.sweep.kucoin, rules.min) / 100) * 100;
    if (!amount) {
      if (!prev) return false;
      state.kucoinWithdrawAlert = null;
      return true;
    }
    const now = Date.now();
    if (prev && amount < prev.etn * 1.5 && now - Date.parse(prev.at) < 86400000) return false;
    const fromTrade = Math.max(0, amount + rules.fee - (main.ETN || 0));
    const text =
      `🏦 *ETN Bot — withdraw ETN from KuCoin*\n\n` +
      `KuCoin holds ${fmtEtn(have)} ETN (Trading ${fmtEtn(trade.ETN || 0)}, Main ${fmtEtn(main.ETN || 0)}); the bot keeps ${fmtEtn(cfg.sweep.kucoin.float)} there.\n\n` +
      `Withdraw *${fmtEtn(amount)} ETN* to the bot wallet:\n\`${wallet.address}\`\n` +
      `Network: Electroneum (ETN-EVM) · fee ${rules.fee} ETN` +
      (fromTrade > 0 ? `\n\nMove ${fmtEtn(Math.ceil(fromTrade))} ETN from Trading to Main in the KuCoin app first.` : "") +
      `\n\n_The bot can't withdraw it itself: ${sweepOff.has("kucoin") ? "the KuCoin key has no Withdraw permission" : "the sweep (ETN_BOT_CEX_SWEEP) is off"}._`;
    let sent = 0;
    for (const viewer of alert.viewers()) {
      const chatId = await alert.chatIdFor(viewer).catch(() => null);
      if (chatId == null) {
        console.log(`🤖 ETN bot: ${viewer} isn't linked to the Core Tier Telegram bot — no KuCoin withdraw alert for it`);
        continue;
      }
      await alert.send(chatId, text).then(() => sent++, (err) => console.error(`⚠️  ETN bot: withdraw alert to ${viewer} failed:`, err.message));
    }
    notify(`📨 KuCoin withdraw alert: ${fmtEtn(amount)} ETN due, sent to ${sent} chat(s)`);
    state.kucoinWithdrawAlert = { etn: amount, at: new Date(now).toISOString() };
    return true;
  }

  // Hyperlane warp routes on Electroneum (see utils/hyperlaneBridge.js): USDC -> Base (domain 8453, the
  // cheapest, ~64 ETN), USDT -> Ethereum (domain 1, its only route, ~391 ETN). Both release the native
  // token there — the exact contracts KuCoin credits — straight into KuCoin's deposit address.
  const HYP_ABI = ["function transferRemote(uint32 _destination, bytes32 _recipient, uint256 _amountOrId) payable returns (bytes32)", "function quoteGasPayment(uint32) view returns (uint256)"];
  const BRIDGE = { USDC: { domain: 8453, chain: "base" }, USDT: { domain: 1, chain: "eth" } };

  /** One round-trip transfer if one is due (decideRebalance). Returns true when it moved something. Every
   * fee is added to the live hedge book's costs, so its net result stays honest. The bot only ever
   * withdraws to its own wallet. */
  async function rebalanceHedge(state) {
    const hb = state.hedgeLive;
    if (!hb || !wallet) return false;
    hb.inTransit = hb.inTransit || [];
    hb.costsEtn = hb.costsEtn || 0;
    hb.costsUsd = hb.costsUsd || 0;
    const [trade, main] = await Promise.all([getBalances("trade"), getBalances("main")]);
    // USDT the refill (refillCex) withdrew from HTX lands in Main too — it's the arbitrage's, not the hedges'.
    main.USDT = Math.max(0, main.USDT - (state.cexRefill?.usdt?.pending?.usd || 0));
    const walletEtn = Number(ethers.formatEther(await provider.getBalance(wallet.address))) - cfg.gasReserveEtn - 1000;
    const room = Math.max(0, Math.min(cfg.hedgeMaxEtnOut + hb.walletEtnNet, walletEtn));
    const a = decideRebalance({ trade, main }, hb, room, cfg.cexSweep ? { ...cfg.rebalance, etnHigh: Infinity } : cfg.rebalance);
    if (!a) return false;
    const oid = (tag) => `etnbot-rb-${tag}-${Date.now()}`;
    const at = new Date().toISOString();
    switch (a.type) {
      case "sweepUsdc": {
        await innerTransfer({ currency: "USDC", from: "main", to: "trade", amount: floorToIncrement(a.amount, 0.000001), clientOid: oid("t") });
        notify(`🔄 Round trip: ${fmtUsd(a.amount)} USDC arrived on KuCoin, moved to its trading account`);
        break;
      }
      case "convertUsdc": {
        const rules = await getSymbolRules("USDC-USDT");
        const fill = await marketSellOn("USDC-USDT", floorToIncrement(a.amount, rules.baseIncrement), oid("cv"));
        const usdt = fill.dealFunds - (fill.feeCurrency === "USDT" ? fill.fee : 0);
        hb.kucoinUsdNet += usdt;
        hb.costsUsd += a.amount - usdt;
        settleArrival(hb, "USDC", a.amount);
        notify(`🔄 Round trip: converted ${fmtUsd(a.amount)} USDC to ${fmtUsd(usdt)} USDT on KuCoin for hedging`);
        break;
      }
      case "sweepUsdt":
      case "sweepEtn": {
        const cur = a.type === "sweepUsdt" ? "USDT" : "ETN";
        await innerTransfer({ currency: cur, from: "main", to: "trade", amount: cur === "ETN" ? Math.floor(a.amount) : floorToIncrement(a.amount, 0.000001), clientOid: oid("t") });
        if (cur === "USDT") hb.kucoinUsdNet += a.amount;
        else hb.kucoinEtnNet += a.amount;
        settleArrival(hb, cur, a.amount);
        notify(`🔄 Round trip: ${cur === "ETN" ? `${fmtEtn(a.amount)} ETN` : fmtUsd(a.amount) + " USDT"} arrived on KuCoin, moved to its trading account`);
        break;
      }
      case "withdrawEtn": {
        const rules = await getWithdrawRules("ETN", "etnevm");
        if (!rules.enabled) throw new Error("KuCoin ETN withdrawals are suspended");
        await innerTransfer({ currency: "ETN", from: "trade", to: "main", amount: Math.ceil(a.amount + rules.fee), clientOid: oid("t") });
        noteBotWithdrawal(state, await withdraw({ currency: "ETN", address: wallet.address, amount: a.amount, chain: "etnevm" }));
        hb.kucoinEtnNet -= a.amount + rules.fee;
        hb.walletEtnNet += a.amount;
        hb.costsEtn += rules.fee;
        notify(`🔄 Round trip: withdrew ${fmtEtn(a.amount)} ETN from KuCoin to the bot wallet (fee ${fmtEtn(rules.fee)} ETN)`);
        break;
      }
      case "bridgeUsdc":
      case "bridgeUsdt": {
        const cur = a.type === "bridgeUsdc" ? "USDC" : "USDT";
        const route = BRIDGE[cur];
        const dep = await getDepositAddress(cur, route.chain);
        if (!dep?.address) throw new Error(`no KuCoin ${cur} deposit address on ${route.chain} — create one on KuCoin's Deposit page first`);
        const token = new ethers.Contract(POOLS[cur].token, HYP_ABI, wallet);
        const fee = await token.quoteGasPayment(route.domain);
        const tx = await token.transferRemote(route.domain, ethers.zeroPadValue(dep.address, 32), ethers.parseUnits(floorTo(a.amount, 6), 6), { value: fee });
        await tx.wait();
        hb.stables[cur] = (hb.stables[cur] || 0) - a.amount;
        hb.inTransit.push({ currency: cur, usd: a.amount, tx: tx.hash, at });
        hb.costsEtn += Number(ethers.formatEther(fee));
        notify(`🔄 Round trip: bridged ${fmtUsd(a.amount)} ${cur} to KuCoin via Hyperlane (${route.chain}, fee ${fmtEtn(Number(ethers.formatEther(fee)))} ETN) — tx ${tx.hash}`);
        break;
      }
      case "depositEtn": {
        const dep = await getDepositAddress("ETN", "etnevm");
        if (!dep?.address) throw new Error("no KuCoin ETN deposit address — create one on KuCoin's Deposit page first");
        const tx = await wallet.sendTransaction({ to: dep.address, value: ethers.parseEther(String(a.amount)) });
        await tx.wait();
        hb.walletEtnNet -= a.amount;
        hb.inTransit.push({ currency: "ETN", etn: a.amount, tx: tx.hash, at });
        notify(`🔄 Round trip: sent ${fmtEtn(a.amount)} ETN to KuCoin for buy-side hedges — tx ${tx.hash}`);
        break;
      }
      default:
        return false;
    }
    actedThisTick = true;
    return true;
  }

  /** Hedged trades (see etnHedgeStrategy.js), across every CEX in cexVenues.js. When a pool is far enough
   * from KuCoin's price, prices selling ETN on ElectroSwap and buying it back on a CEX (or the reverse) —
   * real ElectroSwap quotes, each venue's live book, after its fee — and takes the best venue.
   *  - PAPER (always, public data): records the best hedge it could have made, once per pool state.
   *  - LIVE (cfg.hedgeLive): trades it on a venue whose key is set — the ElectroSwap leg, then the CEX leg
   *    at once (runCexLeg: an IOC limit order capped at break-even, so the pair can't lose money).
   * Returns true when it traded (one action per check). */
  async function hedgeCheck(state, mids, kMid, canSpendEtn, day) {
    if (!state.hedge) state.hedge = freshHedgeBook();
    if (cfg.hedgeLive && !state.hedgeLive) state.hedgeLive = freshLiveHedgeBook();
    const hb = state.hedgeLive;
    const lags = lagsPct(mids, kMid);
    const dear = lags.USDT >= lags.USDC ? "USDT" : "USDC";
    const cheap = other(dear);
    const sellSide = lags[dear] >= cfg.hedgeLagPct;
    const buySide = lags[cheap] <= -cfg.hedgeLagPct;
    if (!sellSide && !buySide) return false;
    const midsKey = `${mids.USDT}|${mids.USDC}`;
    const liveReady = Boolean(cfg.hedgeLive && hb && !hb.pausedReason && !state.hedgeLeg && (state.hedgeTradesByDay?.[day] || 0) < cfg.hedgeMaxTradesPerDay);
    if (state.hedgeLastKey === midsKey && !liveReady) return false;
    const books = await allBooks();
    if (!Object.keys(books).length) return false;
    // ElectroSwap side quoted once per size, then priced against every venue's book.
    const esSell = {}, esBuy = {};
    for (const usd of HEDGE_DEFAULTS.sizesUsd) {
      if (sellSide) esSell[usd] = await quoteSellEtn(dear, usd / mids[dear]).catch(() => 0);
      if (buySide) esBuy[usd] = await quoteBuyEtn(cheap, usd).catch(() => 0);
    }
    const candidates = [];
    for (const [venue, book] of Object.entries(books)) {
      for (const usd of HEDGE_DEFAULTS.sizesUsd) {
        if (sellSide) {
          const etn = usd / mids[dear];
          const kc = kucoinFill(book.asks, etn, "buy");
          if (kc) candidates.push({ venue, dir: "sellOnEs", stable: dear, etn, esUsd: esSell[usd], kcUsd: kc.usd, lagPct: lags[dear] });
        }
        if (buySide && esBuy[usd] > 0) {
          const kc = kucoinFill(book.bids, esBuy[usd], "sell");
          if (kc) candidates.push({ venue, dir: "buyOnEs", stable: cheap, usd, etn: esBuy[usd], kcUsd: kc.usd, lagPct: lags[cheap] });
        }
      }
    }
    const best = (list) => {
      let pick = null;
      for (const v of Object.keys(VENUES)) {
        const h = decideHedge(list.filter((c) => c.venue === v), { ...HEDGE_DEFAULTS, lagPct: cfg.hedgeLagPct, kucoinFeePct: VENUES[v].feePct });
        if (h && (!pick || h.profitUsd > pick.profitUsd)) pick = h;
      }
      return pick;
    };

    // Paper record — every opportunity on any venue, sized without balance limits, once per pool state.
    const paper = best(candidates);
    if (paper && state.hedgeLastKey !== midsKey) {
      state.hedgeLastKey = midsKey;
      applyHedge(state.hedge, paper, { kucoinPrice: kMid, at: new Date().toISOString() });
      const fee = VENUES[paper.venue].feePct / 100;
      const what = paper.dir === "sellOnEs"
        ? `sell ${fmtEtn(paper.etn)} ETN on ElectroSwap for ${fmtUsd(paper.esUsd)} ${paper.stable}, buy it back on ${VENUES[paper.venue].name} for ${fmtUsd(paper.kcUsd * (1 + fee))}`
        : `buy ${fmtEtn(paper.etn)} ETN on ElectroSwap for ${fmtUsd(paper.usd)} ${paper.stable}, sell it on ${VENUES[paper.venue].name} for ${fmtUsd(paper.kcUsd * (1 - fee))}`;
      console.log(`🧪 ETN bot (hedge, paper): ElectroSwap ${paper.lagPct >= 0 ? "+" : ""}${paper.lagPct.toFixed(1)}% vs KuCoin — would ${what}: +${fmtUsd(paper.profitUsd)} (${paper.profitPct.toFixed(2)}%, ≈ +${fmtEtn(paper.profitUsd / kMid)} ETN). Paper total +${fmtUsd(state.hedge.profitUsd)} over ${state.hedge.trades}`);
    }
    if (!liveReady) return false;

    // Live: only venues with a key whose market is open, within the size cap and what both sides hold.
    const usable = {};
    for (const v of Object.keys(books)) {
      if (!VENUES[v].configured()) continue;
      const st = await VENUES[v].status().catch(() => null);
      if (!st?.trading || nowMs() - books[v].ts > ARB_DEFAULTS.maxBookAgeMs) continue;
      usable[v] = await VENUES[v].balances().catch(() => null);
    }
    const affordable = candidates.filter((c) => {
      const bal = usable[c.venue];
      if (!bal) return false;
      return c.dir === "sellOnEs"
        ? (c.esUsd || 0) <= cfg.hedgeMaxUsd && canSpendEtn(c.etn) && hb.walletEtnNet - c.etn >= -cfg.hedgeMaxEtnOut && bal.USDT >= (c.esUsd || 0) * 1.02
        : c.usd <= cfg.hedgeMaxUsd && (hb.stables[c.stable] || 0) >= c.usd && bal.ETN >= c.etn * 1.02;
    });
    const h = best(affordable);
    if (!h) return false;
    state.hedgeTradesByDay = { [day]: (state.hedgeTradesByDay?.[day] || 0) + 1 };
    const order = h.dir === "sellOnEs"
      ? { kind: "hedgeSellEs", side: "sellEtn", stable: h.stable, amountIn: h.etn, expectedOut: h.esUsd, lagPct: h.lagPct, venue: h.venue }
      : { kind: "hedgeBuyEs", side: "buyEtn", stable: h.stable, amountIn: h.usd, expectedOut: h.etn, lagPct: h.lagPct, venue: h.venue };
    const first = await execute(state, order);
    if (first === "filled" && state.hedgeLeg) await completeHedgeLeg(state);
    await saveWithRetry(state);
    return true;
  }

  /** The CEX leg of a live hedge (after its ElectroSwap leg, or retried on the next check). */
  async function completeHedgeLeg(state) {
    const leg = state.hedgeLeg;
    const hb = state.hedgeLive || (state.hedgeLive = freshLiveHedgeBook());
    if (!leg.cex) {
      leg.cex = leg.dir === "sellOnEs"
        ? { venue: leg.venue || "kucoin", side: "buy", budgetUsd: leg.esUsd, breakEvenEtn: leg.esEtn, gotEtn: 0, spentUsd: 0, attempts: 0, clientOid: leg.clientOid }
        : { venue: leg.venue || "kucoin", side: "sell", targetUsd: leg.esUsd, availableEtn: leg.esEtn, soldEtn: 0, gotUsd: 0, attempts: 0, clientOid: leg.clientOid };
    }
    const r = await runCexLeg(leg.cex, (msg) => notify(`⚠️ Hedge ${VENUES[leg.cex.venue].name} leg: ${msg}`));
    if (r === "done") {
      const c = leg.cex;
      const kcEtn = c.side === "buy" ? c.gotEtn : c.soldEtn;
      const kcUsd = c.side === "buy" ? c.spentUsd : c.gotUsd;
      const gain = applyLiveHedge(hb, { ...leg, kcEtn, kcUsd });
      hb.byVenue = hb.byVenue || {};
      const bv = (hb.byVenue[c.venue] = hb.byVenue[c.venue] || { trades: 0, gainEtn: 0 });
      bv.trades += 1;
      bv.gainEtn += gain;
      state.hedgeLeg = null;
      hb.failures = 0;
      const lag = `${(leg.lagPct ?? 0) >= 0 ? "+" : ""}${(leg.lagPct ?? 0).toFixed(1)}%`;
      const name = VENUES[c.venue].name;
      notify(
        leg.dir === "sellOnEs"
          ? `⚖️ Hedge: ElectroSwap ${lag} vs KuCoin — sold ${fmtEtn(leg.esEtn)} ETN there for ${fmtUsd(leg.esUsd)} ${leg.stable}, bought ${fmtEtn(kcEtn)} ETN on ${name} for ${fmtUsd(kcUsd)} — ${signedEtn(gain)} ETN. Hedge total: ${signedEtn(hb.gainEtn)} ETN over ${hb.trades}`
          : `⚖️ Hedge: ElectroSwap ${lag} vs KuCoin — bought ${fmtEtn(leg.esEtn)} ETN there for ${fmtUsd(leg.esUsd)} ${leg.stable}, sold ${fmtEtn(kcEtn)} ETN on ${name} for ${fmtUsd(kcUsd)} — ${signedEtn(gain)} ETN. Hedge total: ${signedEtn(hb.gainEtn)} ETN over ${hb.trades}`
      );
    } else if (r === "failed") {
      hb.failures = (hb.failures || 0) + 1;
      if (hb.failures >= 3) {
        hb.pausedReason = `${VENUES[leg.cex.venue].name} leg failed 3 times`;
        notify(`⏸️ Live hedging paused: ${hb.pausedReason}. The unfinished leg stays in the bot's state (hedgeLeg); a restart retries it.`);
      }
    }
  }

  /**
   * Runs (or continues) the second leg of a two-venue trade on a CEX, as IOC limit orders capped at
   * break-even (buyLegOrder / sellLegOrder) — so whatever fills, the pair doesn't lose money. Mutates
   * `c` with each fill, so a partial fill carries on next time with what's left:
   *   buy:  c.budgetUsd to spend, c.breakEvenEtn still needed; c.gotEtn / c.spentUsd so far
   *   sell: c.targetUsd still to raise, c.availableEtn left; c.soldEtn / c.gotUsd so far
   * Every attempt has its own clientOid, checked first — an order that went through before a crash is
   * read back, never placed twice. Returns "done" | "pending" (nothing filled this time — the market
   * is beyond break-even; try again next check) | "failed" (an error).
   */
  async function runCexLeg(c, warn) {
    const v = VENUES[c.venue];
    try {
      const rules = await v.rules();
      const oid = `${c.clientOid}-${c.attempts}`;
      let fill = await v.byClientOid(oid).catch(() => null);
      if (!fill?.done) {
        const book = await v.book();
        const order = c.side === "buy"
          ? buyLegOrder({ asks: book.asks, budgetUsd: c.budgetUsd, breakEvenEtn: Math.max(c.breakEvenEtn, 1e-9), feePct: v.feePct, rules })
          : sellLegOrder({ bids: book.bids, targetUsd: c.targetUsd, availableEtn: c.availableEtn, feePct: v.feePct, rules });
        if (!order) return "done"; // what's left is below the venue's minimum order: dust, kept as is
        fill = await v.ioc({ side: c.side, size: order.size, price: order.price, clientOid: oid });
      }
      c.attempts += 1;
      const n = netFill(c.side, fill);
      if (c.side === "buy") {
        c.gotEtn += n.etn;
        c.spentUsd += n.usd;
        c.budgetUsd -= n.usd;
        c.breakEvenEtn -= n.etn;
        if (c.breakEvenEtn <= 0 || c.budgetUsd < Math.max(1, (await v.rules()).minFunds)) return "done";
      } else {
        c.soldEtn += n.etn;
        c.gotUsd += n.usd;
        c.targetUsd -= n.usd;
        c.availableEtn -= n.etn;
        if (c.targetUsd <= 0.01 || c.availableEtn < (await v.rules()).minSize) return "done";
      }
      if (n.etn <= 0) warn?.(`nothing filled within break-even (attempt ${c.attempts}); retrying next check`);
      return "pending";
    } catch (err) {
      warn?.(err.message);
      return "failed";
    }
  }

  /** CEX-vs-CEX arbitrage (services/cexArbStrategy.js): buy ETN on the venue where it's cheap, sell it on
   * the one where it's dear. Every check in arbChecks must pass before the first leg is placed; the
   * first leg is on the thinner venue (HTX) as an IOC at the planned worst price, the second sized to
   * what actually filled and capped at break-even (runCexLeg). PAPER logs what it would do. Returns true
   * when it traded. */
  async function cexArbCheck(state, day) {
    if (!state.cexArb) state.cexArb = freshArbBook();
    const ab = state.cexArb;
    if (ab.today?.day !== day) ab.today = { day, trades: 0, usd: 0 };
    const books = await allBooks();
    if (Object.keys(books).length < 2) return false;
    const plan = planArb(books, feesOf(), cfg.arb);
    if (!plan) return false;
    const key = `${plan.buyVenue}>${plan.sellVenue}|${books[plan.buyVenue].asks[0][0]}|${books[plan.sellVenue].bids[0][0]}`;
    const status = {};
    for (const v of [plan.buyVenue, plan.sellVenue]) status[v] = await VENUES[v].status().catch(() => null);
    const publicChecks = arbChecks({ plan, books, nowMs: nowMs(), status, balances: { [plan.buyVenue]: { USDT: Infinity }, [plan.sellVenue]: { ETN: Infinity } }, book: ab, paused: null }, cfg.arb);
    if (ab.paperKey !== key && !publicChecks.length) {
      ab.paperKey = key;
      ab.paper = ab.paper || { trades: 0, profitUsd: 0 };
      ab.paper.trades += 1;
      ab.paper.profitUsd += plan.profitUsd;
      console.log(`🧪 ETN bot (CEX arb, paper): buy ${fmtEtn(plan.etn)} ETN on ${VENUES[plan.buyVenue].name} for ${fmtUsd(plan.buyUsd)}, sell on ${VENUES[plan.sellVenue].name} for ${fmtUsd(plan.sellUsd)} — +${fmtUsd(plan.profitUsd)} (${plan.edgePct.toFixed(2)}% after fees). Paper total +${fmtUsd(ab.paper.profitUsd)} over ${ab.paper.trades}`);
    }
    if (!cfg.arbLive || state.arbLeg || !VENUES[plan.buyVenue].configured() || !VENUES[plan.sellVenue].configured()) return false;

    const balances = {};
    for (const v of [plan.buyVenue, plan.sellVenue]) balances[v] = await VENUES[v].balances();
    const fails = arbChecks({ plan, books, nowMs: nowMs(), status, balances, book: ab, paused: ab.paused }, cfg.arb);
    if (fails.length) {
      if (ab.lastBlockedKey !== key) {
        ab.lastBlockedKey = key;
        console.log(`🛑 ETN bot (CEX arb): ${plan.edgePct.toFixed(2)}% ${VENUES[plan.buyVenue].name} -> ${VENUES[plan.sellVenue].name} not traded — ${fails.join("; ")}`);
      }
      return false;
    }

    // First leg on the thinner venue (HTX when it's one of the two), as an IOC at the planned worst price.
    const firstIsSell = plan.sellVenue === "htx" || plan.buyVenue !== "htx";
    const firstVenue = firstIsSell ? plan.sellVenue : plan.buyVenue;
    const fv = VENUES[firstVenue];
    const rules = await fv.rules();
    const oid = `etnarb-${Date.now()}`;
    const firstOrder = firstIsSell
      ? { venue: firstVenue, side: "sell", size: roundDown(plan.etn, rules.sizeStep), price: roundUp(plan.sellLimit, rules.priceStep), clientOid: `${oid}-a` }
      : { venue: firstVenue, side: "buy", size: roundDown(plan.etn, rules.sizeStep), price: roundDown(plan.buyLimit, rules.priceStep), clientOid: `${oid}-a` };
    // Recorded BEFORE it's placed: if placing it throws (a timeout, a restart) after it actually went
    // through, the next check finds it by its clientOid instead of losing track of real money.
    ab.lastTradeAt = new Date().toISOString();
    state.arbLeg = { stage: "first", firstOrder, plan: { buyVenue: plan.buyVenue, sellVenue: plan.sellVenue, edgePct: plan.edgePct }, oid, at: ab.lastTradeAt };
    await saveWithRetry(state);
    const fill = await fv.ioc(firstOrder).catch((err) => {
      notify(`⚠️ CEX arb: first leg on ${fv.name} errored (${err.message}) — checking it by its order id next check`);
      return null;
    });
    if (fill) startSecondLeg(state, fill);
    if (state.arbLeg?.stage === "second") await completeArbLeg(state);
    await saveWithRetry(state);
    return true;
  }

  /** First leg filled (or found filled): set up the second, sized to what actually filled. Nothing filled
   * -> no trade, nothing held. */
  function startSecondLeg(state, fill) {
    const leg = state.arbLeg;
    const fo = leg.firstOrder;
    const f = netFill(fo.side, fill);
    if (!(f.etn > 0)) {
      console.log(`🤖 ETN bot (CEX arb): first leg on ${VENUES[fo.venue].name} filled nothing (the book moved) — no trade`);
      state.arbLeg = null;
      return;
    }
    const secondVenue = fo.side === "sell" ? leg.plan.buyVenue : leg.plan.sellVenue;
    leg.stage = "second";
    leg.first = { venue: fo.venue, side: fo.side, etn: f.etn, usd: f.usd };
    leg.cex = fo.side === "sell"
      ? { venue: secondVenue, side: "buy", budgetUsd: f.usd, breakEvenEtn: f.etn, gotEtn: 0, spentUsd: 0, attempts: 0, clientOid: `${leg.oid}-b` }
      : { venue: secondVenue, side: "sell", targetUsd: f.usd, availableEtn: f.etn, soldEtn: 0, gotUsd: 0, attempts: 0, clientOid: `${leg.oid}-b` };
  }

  async function completeArbLeg(state) {
    const ab = state.cexArb || (state.cexArb = freshArbBook());
    if (state.arbLeg?.stage === "first") {
      // A first leg whose result we never saw: look it up by its clientOid.
      const fo = state.arbLeg.firstOrder;
      const found = await VENUES[fo.venue].byClientOid(fo.clientOid).catch(() => undefined);
      if (found === undefined) return; // couldn't ask — try again next check
      if (!found) {
        notify(`ℹ️ CEX arb: the first leg on ${VENUES[fo.venue].name} was never placed — nothing to finish`);
        state.arbLeg = null;
        return;
      }
      if (!found.done) return; // still working
      startSecondLeg(state, found);
      if (!state.arbLeg) return;
    }
    const leg = state.arbLeg;
    const r = await runCexLeg(leg.cex, (msg) => notify(`⚠️ CEX arb ${VENUES[leg.cex.venue].name} leg: ${msg}`));
    if (r === "done") {
      const c = leg.cex;
      // ETN gained = ETN bought minus ETN sold; dollars left over (sell proceeds minus buy cost) kept as $.
      const gainEtn = c.side === "buy" ? c.gotEtn - leg.first.etn : leg.first.etn - c.soldEtn;
      const gainUsd = c.side === "buy" ? leg.first.usd - c.spentUsd : c.gotUsd - leg.first.usd;
      ab.trades += 1;
      ab.gainEtn += gainEtn;
      ab.gainUsd += gainUsd;
      ab.notionalUsd += leg.first.usd;
      ab.today.trades += 1;
      ab.today.usd += leg.first.usd;
      ab.failures = 0;
      ab.recent.push({ at: leg.at, buyVenue: leg.plan.buyVenue, sellVenue: leg.plan.sellVenue, etn: leg.first.etn, usd: leg.first.usd, gainEtn, gainUsd, edgePct: leg.plan.edgePct });
      if (ab.recent.length > 50) ab.recent.shift();
      state.arbLeg = null;
      notify(`↔️ CEX arb: bought on ${VENUES[leg.plan.buyVenue].name}, sold on ${VENUES[leg.plan.sellVenue].name} (${fmtEtn(leg.first.etn)} ETN, ${fmtUsd(leg.first.usd)}) — ${signedEtn(gainEtn)} ETN${Math.abs(gainUsd) >= 0.01 ? ` ${gainUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(gainUsd))}` : ""}. Arb total: ${signedEtn(ab.gainEtn)} ETN over ${ab.trades}`);
    } else if (r === "failed" || leg.cex.attempts >= 10) {
      ab.failures = (ab.failures || 0) + 1;
      if (ab.failures >= 3 || leg.cex.attempts >= 10) {
        ab.paused = `${VENUES[leg.cex.venue].name} leg didn't complete (${leg.cex.attempts} attempts)`;
        notify(`⏸️ CEX arb paused: ${ab.paused}. The unfinished leg stays in the bot's state (arbLeg); a restart retries it.`);
      }
    }
  }

  /** ETN it would take right now to get each open catch-up lot's dollars back in its own pool. */
  async function catchupNeeds(book) {
    const quoter = new ethers.Contract(QUOTER, QUOTER_OUT_ABI, provider);
    const needs = {};
    for (const lot of book.lots.filter((l) => l.kind !== "sellFirst")) {
      const p = POOLS[lot.stable];
      try {
        const r = await quoter.quoteExactOutputSingle.staticCall({ tokenIn: WETN, tokenOut: p.token, amount: ethers.parseUnits(floorTo(lot.usd, p.decimals), p.decimals), fee: p.fee, sqrtPriceLimitX96: 0 });
        needs[lot.id] = Number(ethers.formatEther(r.amountIn));
      } catch {
        // unquotable this tick — not eligible
      }
    }
    return needs;
  }

  /** Gap trade candidates — only quoted when the pools' mid prices are far enough apart to clear the
   * fees at all (a cheap pre-screen on the mids already read; the full quotes are six quoter calls). */
  async function gapCandidates(mids, book) {
    const gapPct = Math.abs(Math.log(mids.USDT / mids.USDC)) * 100;
    if (gapPct < cfg.gapMinGainPct + 0.6) return { gapPct, candidates: [] };
    const dear = mids.USDT > mids.USDC ? "USDT" : "USDC";
    const cheap = other(dear);
    const candidates = [];
    for (const etnIn of gapSizes(cfg.gapClipEtn, affordableLegEtn(book.stables[cheap], mids[dear]))) {
      try {
        const stableOut = await quoteSellEtn(dear, etnIn);
        candidates.push({ dear, cheap, etnIn, stableOut, etnBack: await quoteBuyEtn(cheap, stableOut) });
      } catch {
        // unquotable size — skip
      }
    }
    return { gapPct, candidates };
  }

  async function tick() {
    if (pausedReason && pausedUntil && Date.now() >= pausedUntil) {
      notify(`▶️ Resumed after a ${Math.round(cfg.simPauseMs / 60000)}-minute pause (${pausedReason})`);
      pausedReason = null;
      pausedUntil = null;
      consecutiveFailures = 0;
    }
    if (running || pausedReason || stopped) return;
    running = true;
    actedThisTick = false;
    let tickMids = null;
    let tickK = null;
    try {
      // Only the instance holding the lease trades (see claimBotLease) — never two at once over a deploy.
      if (store.claimLease) {
        const lease = await store.claimLease(owner);
        if (!lease.ok) {
          if (leaseHolderLogged !== lease.holder) console.log(`🤖 ETN bot: standing by — another instance (${lease.holder}) is running the bot`);
          leaseHolderLogged = lease.holder;
          return;
        }
        if (leaseHolderLogged || lease.took) console.log(`🤖 ETN bot: took over from ${lease.took || leaseHolderLogged} (instance ${owner})`);
        leaseHolderLogged = null;
      }
      const state = (await store.get(cfg.mode)) || freshState(cfg);
      if (state.budgetEtn !== cfg.budgetEtn) {
        console.log(`🤖 ETN bot: budget ${state.budgetEtn} -> ${cfg.budgetEtn} ETN (ETN_BOT_BUDGET_ETN changed)`);
        state.budgetEtn = cfg.budgetEtn;
      }
      if (cfg.gapEnabled && !state.gap) state.gap = freshGapBook();
      if (cfg.triEnabled && !state.tri) state.tri = freshTriangleBook();
      if (cfg.cuEnabled && !state.cu) state.cu = freshCatchupBook(cfg.cuPotUsd);
      if (state.cu) {
        state.cu.target = cfg.cuPotUsd; // follows ETN_BOT_CU_POT_USD; only new deposits fill it
        if (cfg.mode === "paper" && (state.cu.funded || 0) < state.cu.target) {
          const room = state.cu.target - (state.cu.funded || 0); // paper: a virtual pot, half in each stablecoin
          applyCatchupFunding(state.cu, "USDT", room / 2);
          applyCatchupFunding(state.cu, "USDC", room / 2);
        }
      }

      // A trade still in flight from a previous tick/process: settle it before anything else.
      if (state.pending) {
        const result = await resolvePending(state);
        await saveWithRetry(state);
        if (result === "waiting") return;
      }
      // A gap trade whose second leg hasn't run (a failure or restart between the legs): finish it first.
      if (!hedgePauseCheckedSinceStart) {
        hedgePauseCheckedSinceStart = true;
        if (state.hedgeLive?.pausedReason) {
          notify(`▶️ Live hedging resumed after a restart (was paused: ${state.hedgeLive.pausedReason})${state.hedgeLeg ? " — retrying the unfinished KuCoin leg" : ""}`);
          state.hedgeLive.pausedReason = null;
          state.hedgeLive.failures = 0;
        }
        if (state.cexArb?.paused) {
          notify(`▶️ CEX arb resumed after a restart (was paused: ${state.cexArb.paused})${state.arbLeg ? " — retrying the unfinished leg" : ""}`);
          state.cexArb.paused = null;
          state.cexArb.failures = 0;
        }
      }
      // A live hedge whose KuCoin leg hasn't run yet: finish it first (unless hedging is paused over it).
      if (state.hedgeLeg && cfg.hedgeLive && !state.hedgeLive?.pausedReason) {
        await completeHedgeLeg(state);
        await saveWithRetry(state);
        return;
      }
      // Excess ETN off the exchanges, at most every cexSweepEveryMs.
      if (cfg.cexSweep && Date.now() - lastSweepAt >= cfg.cexSweepEveryMs) {
        lastSweepAt = Date.now();
        const swept = await sweepExcessEtn(state).catch((err) => {
          notify(`⚠️ Sweeping ETN back to the wallet failed: ${err.message}`);
          return false;
        });
        if (swept) {
          await saveWithRetry(state);
          return;
        }
      }
      // Restocking the exchanges for the arbitrage, at most every cexRefillEveryMs.
      if (cfg.cexRefill && Date.now() - lastRefillAt >= cfg.cexRefillEveryMs) {
        lastRefillAt = Date.now();
        const changed = await refillCex(state).catch((err) => {
          notify(`⚠️ Refilling the exchanges failed: ${err.message}`);
          return false;
        });
        if (changed) {
          await saveWithRetry(state);
          return;
        }
      }
      if (cfg.mode === "live" && Date.now() - lastWithdrawAlertCheckAt >= cfg.cexSweepEveryMs) {
        lastWithdrawAlertCheckAt = Date.now();
        const booked = await bookManualWithdrawals(state).catch((err) => {
          console.error("⚠️  ETN bot: booking manual KuCoin withdrawals failed:", err.message);
          return false;
        });
        const changed = await kucoinWithdrawAlert(state).catch((err) => {
          console.error("⚠️  ETN bot: KuCoin withdraw alert check failed:", err.message);
          return false;
        });
        if (booked || changed) await saveWithRetry(state);
      }
      // The round trip, at most every hedgeRebalanceEveryMs and never mid-hedge.
      if (cfg.hedgeRebalance && state.hedgeLive && !state.hedgeLeg && !state.hedgeLive.pausedReason && Date.now() - lastRebalanceAt >= cfg.hedgeRebalanceEveryMs) {
        lastRebalanceAt = Date.now();
        const moved = await rebalanceHedge(state).catch((err) => {
          notify(`⚠️ Round trip step failed: ${err.message}`);
          return false;
        });
        if (moved) {
          await saveWithRetry(state);
          return;
        }
      }
      if (state.arbLeg && cfg.arbLive && !state.cexArb?.paused) {
        await completeArbLeg(state);
        await saveWithRetry(state);
        return;
      }
      if (state.gapLeg) {
        await completeGapLeg(state);
        await saveWithRetry(state);
        return;
      }

      // The venues' real taker fees (hourly) — every break-even price below uses them.
      if (cfg.hedgeLive || cfg.arbLive || cfg.hedgePaper || cfg.arbPaper) await refreshFees().catch(() => null);

      // CEX-vs-CEX arbitrage — its own action (it doesn't touch the pools).
      if (cfg.arbPaper || cfg.arbLive) {
        const traded = await cexArbCheck(state, new Date().toISOString().slice(0, 10)).catch((err) => {
          console.warn("⚠️  ETN bot: CEX arb check failed:", err.message);
          return false;
        });
        if (traded) {
          await saveWithRetry(state);
          return;
        }
      }

      // Price EMA (mid of both pools).
      const mids = {};
      for (const [stable, p] of Object.entries(POOLS)) mids[stable] = await midPrice(provider, p);
      tickMids = mids;
      const mid = (mids.USDT + mids.USDC) / 2;
      const now = Date.now();
      state.ema = updateEma(state.ema, mid, state.emaAt ? now - new Date(state.emaAt).getTime() : 0, cfg.emaHalfLifeHours * 3600000);
      state.emaAt = new Date(now).toISOString();
      state.samples = (state.samples || 0) + 1;

      // USDT/USDC you send to the wallet joins the gap book (live only; see reconcileGapStables).
      if ((cfg.gapEnabled || cfg.cuEnabled) && cfg.mode === "live" && wallet) await reconcileGapStables(state, mids);

      const quotes = await gatherQuotes(provider, state, cfg.clipEtn);
      if (wallet) {
        const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
        quotes.walletEtn = bal - cfg.gasReserveEtn;
      }
      const decision = decide(state, quotes, cfg);
      const inventory = botEtnInventory(state);
      const canSpendEtn = (etn) => inventory >= etn && (quotes.walletEtn == null || quotes.walletEtn >= etn);
      const floorBlocks = cfg.profitFloorEtn > 0 ? await checkProfitFloor(state, quotes.buyback) : { buys: false, sells: false };

      const day = new Date().toISOString().slice(0, 10);
      state.tradesByDay = { [day]: state.tradesByDay?.[day] || 0 }; // keep today only
      state.gapTradesByDay = { [day]: state.gapTradesByDay?.[day] || 0 };
      state.triTradesByDay = { [day]: state.triTradesByDay?.[day] || 0 };
      state.cuTradesByDay = { [day]: state.cuTradesByDay?.[day] || 0 };
      const lotCapHit = state.tradesByDay[day] >= cfg.maxTradesPerDay;

      // 1. Lot buybacks — they lock in ETN.
      if (decision.action === "buyback" && !lotCapHit) {
        state.tradesByDay[day]++;
        await execute(state, { kind: "buyback", side: "buyEtn", stable: decision.stable, amountIn: decision.stableAmount, expectedOut: decision.expectedEtn, lotId: decision.lotId });
        await saveWithRetry(state);
        return;
      }

      // 2. KuCoin catch-up: close a lot that's caught up (locks in ETN), else buy if ElectroSwap lags.
      let cuNote = "";
      if (cfg.cuEnabled && state.cuTradesByDay[day] < cfg.cuMaxTradesPerDay) {
        const cu = state.cu;
        const kMid = await kucoinPrice();
        tickK = kMid;
        if ((cfg.hedgePaper || cfg.hedgeLive) && kMid) {
          const hedged = await hedgeCheck(state, mids, kMid, canSpendEtn, day).catch((err) => {
            console.warn("⚠️  ETN bot: hedge check failed:", err.shortMessage || err.message);
            return false;
          });
          if (hedged) return; // a live hedge was this check's one action
        }
        if (cu.lots.length) {
          const close = decideCatchupClose(cu, await catchupNeeds(cu), { minGainPct: cfg.cuMinGainPct });
          if (close && (quotes.walletEtn == null || quotes.walletEtn >= close.needEtn)) {
            state.cuTradesByDay[day]++;
            await execute(state, { kind: "cuSell", side: "sellEtn", stable: close.stable, amountIn: close.needEtn, expectedOut: close.usd, lotId: close.lotId });
            await saveWithRetry(state);
            return;
          }
        }
        // Sell-first lots: buy back once their dollars get minGain% more ETN than was sold.
        const sellLots = cu.lots.filter((l) => l.kind === "sellFirst");
        if (sellLots.length) {
          const etnBack = {};
          for (const l of sellLots) etnBack[l.id] = await quoteBuyEtn(l.stable, l.usd).catch(() => 0);
          const back = decideCatchupBuyBack(cu, etnBack, { minGainPct: cfg.cuMinGainPct });
          if (back) {
            state.cuTradesByDay[day]++;
            await execute(state, { kind: "cuBuyBack", side: "buyEtn", stable: back.stable, amountIn: back.usd, expectedOut: back.etnBack, lotId: back.lotId });
            await saveWithRetry(state);
            return;
          }
        }
        if (kMid) {
          const lags = lagsPct(mids, kMid);
          const buy = floorBlocks.buys ? null : decideCatchupBuy(cu, lags, { lagPct: cfg.cuLagPct, clipUsd: cfg.cuClipUsd, reentryMinutes: cfg.cuReentryMinutes });
          if (buy) {
            state.cuTradesByDay[day]++;
            await execute(state, { kind: "cuBuy", side: "buyEtn", stable: buy.stable, amountIn: buy.usd, expectedOut: await quoteBuyEtn(buy.stable, buy.usd), lagPct: buy.lagPct });
            await saveWithRetry(state);
            return;
          }
          const sell = cfg.cuSellEnabled && !floorBlocks.sells
            ? decideCatchupSell(cu, lags, mids, { lagPct: cfg.cuLagPct, clipUsd: cfg.cuClipUsd, reentryMinutes: cfg.cuReentryMinutes, maxSellEtn: cfg.cuMaxSellEtn }, Date.now(), canSpendEtn)
            : null;
          if (sell) {
            state.cuTradesByDay[day]++;
            await execute(state, { kind: "cuSellFirst", side: "sellEtn", stable: sell.stable, amountIn: sell.etn, expectedOut: await quoteSellEtn(sell.stable, sell.etn), lagPct: sell.lagPct });
            await saveWithRetry(state);
            return;
          }
          cuNote = ` · KuCoin ${kMid.toPrecision(4)} (ElectroSwap ${lags.USDT >= 0 ? "+" : ""}${lags.USDT.toFixed(1)}% USDT / ${lags.USDC >= 0 ? "+" : ""}${lags.USDC.toFixed(1)}% USDC; catch-up ${signedEtn(cu.gainEtn)} ETN over ${cu.closed}, ${cu.lots.length} open, pot ${fmtUsd(cu.cash.USDT + cu.cash.USDC)})`;
        } else {
          cuNote = " · KuCoin price unavailable";
        }
      }

      let gapNote = "";
      if (cfg.gapEnabled) {
        const gap = state.gap;
        // 2. Seed the gap book (once per side): half the seed ETN sold into each pool.
        const unseeded = Object.keys(POOLS).find((k) => !gap.seeded[k]);
        if (unseeded) {
          const half = cfg.gapSeedEtn / 2;
          if (canSpendEtn(half)) {
            await execute(state, { kind: "seed", side: "sellEtn", stable: unseeded, amountIn: half, expectedOut: await quoteSellEtn(unseeded, half) });
            await saveWithRetry(state);
            return;
          }
          gapNote = " · gap book not seeded (not enough ETN)";
        } else if (state.gapTradesByDay[day] < cfg.gapMaxTradesPerDay) {
          // 3. A gap trade: sell into the dear pool, buy back in the cheap one.
          const { gapPct, candidates } = await gapCandidates(mids, gap);
          // Paper fills don't move the pools, so the same gap would be "traded" every tick. In paper,
          // wait for either pool's price to actually change (someone else trading) before the next one.
          const midsKey = `${mids.USDT}|${mids.USDC}`;
          const paperStale = cfg.mode === "paper" && state.gapPaperMids === midsKey;
          const d = paperStale ? null : decideGap(gap, candidates.filter((c) => canSpendEtn(c.etnIn)), { minGainPct: cfg.gapMinGainPct });
          if (d) {
            if (cfg.mode === "paper") state.gapPaperMids = midsKey;
            state.gapTradesByDay[day]++;
            const first = await execute(state, { kind: "gapSell", side: "sellEtn", stable: d.dear, cheap: d.cheap, amountIn: d.etnIn, expectedOut: d.stableOut });
            if (first === "filled" && state.gapLeg) await completeGapLeg(state);
            await saveWithRetry(state);
            return;
          }
          gapNote = ` · pool gap ${gapPct.toFixed(2)}% (book ${fmtUsd(gap.stables.USDT)} USDT / ${fmtUsd(gap.stables.USDC)} USDC, +${fmtEtn(gap.gainEtn)} ETN over ${gap.trades})`;
        } else {
          gapNote = ` · gap daily cap (${cfg.gapMaxTradesPerDay}) reached`;
        }
      }

      // 4. A triangle (ETN -> DYNO/BOLT/CLUB -> ETN in one transaction; ETN only, no stablecoin).
      let triNote = "";
      if (cfg.triEnabled) {
        if (state.triTradesByDay[day] < cfg.triMaxTradesPerDay) {
          const { quotes: triQuotes, best, sqrtKey } = await triangleQuotes();
          // Paper fills don't move the pools — same guard as the gap trade's: wait for a pool to change.
          const paperStale = cfg.mode === "paper" && state.triPaperKey === sqrtKey;
          const t = paperStale ? null : decideTriangle(triQuotes, { minGainEtn: cfg.triMinGainEtn }, canSpendEtn);
          if (t) {
            if (cfg.mode === "paper") state.triPaperKey = sqrtKey;
            state.triTradesByDay[day]++;
            await execute(state, { kind: "triangle", route: t.route, amountIn: t.etnIn, expectedOut: t.etnOut });
            await saveWithRetry(state);
            return;
          }
          triNote = ` · best triangle ${best ? `${best.name} ${best.edgePct >= 0 ? "+" : ""}${best.edgePct.toFixed(2)}% before ~${prescreenEdgePct(TRIANGLE_ROUTES.find((r) => r.name === best.name)).toFixed(1)}% fees` : "unreadable"} (+${fmtEtn(state.tri.gainEtn)} ETN over ${state.tri.trades})`;
        } else {
          triNote = ` · triangle daily cap (${cfg.triMaxTradesPerDay}) reached`;
        }
      }

      // 5. A lot sale.
      if (decision.action === "sell" && !lotCapHit && !floorBlocks.sells) {
        state.tradesByDay[day]++;
        await execute(state, { kind: "sell", side: "sellEtn", stable: decision.stable, amountIn: decision.etnAmount, expectedOut: decision.expectedStable, lotId: state.nextLotId++ });
        await saveWithRetry(state);
        return;
      }

      const reason = decision.action === "hold" ? decision.reason : floorBlocks.sells ? `profit floor: ${signedEtn(state.profitFloor.profitEtn)} ETN is under ${fmtEtn(cfg.profitFloorEtn)}, no new sell lots` : `daily trade cap (${cfg.maxTradesPerDay}) reached`;
      if (state.samples % 30 === 1) console.log(`🤖 ETN bot: hold — ${reason} (mid ${mid.toPrecision(4)}, EMA ${state.ema.toPrecision(4)}, inventory ${fmtEtn(inventory)} ETN)${cuNote}${gapNote}${triNote}${cfg.fastMs > 0 ? ` · ${fastWakes} early check(s) since start` : ""}`);
      await saveWithRetry(state);
    } catch (err) {
      console.error("⚠️  ETN bot tick failed:", err.shortMessage || err.message);
    } finally {
      if (tickMids) lastTick = { mids: tickMids, kMid: tickK ?? lastTick?.kMid ?? null, acted: actedThisTick, at: Date.now() };
      running = false;
      if (consecutiveFailures >= 3 && !pausedReason) {
        if (realFailures === 0 && cfg.simPauseMs > 0) {
          pausedReason = "3 swaps in a row rejected in simulation (nothing sent)";
          pausedUntil = Date.now() + cfg.simPauseMs;
          notify(`⏸️ Paused: ${pausedReason} — resuming by itself in ${Math.round(cfg.simPauseMs / 60000)} minutes.`);
        } else {
          pausedReason = "3 failed trades in a row";
          notify(`⏸️ Paused: ${pausedReason}. Restart the service to resume.`);
        }
      }
    }
  }

  /** Shutdown: no new ticks; waits (up to waitMs) for a running one to finish, then releases the lease. */
  async function stop(waitMs = 20000) {
    stopped = true;
    const until = Date.now() + waitMs;
    while (running && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (store.releaseLease) await store.releaseLease(owner).catch((err) => console.error("⚠️  ETN bot: couldn't release the lease:", err.message));
    return !running;
  }

  return {
    tick,
    stop,
    kucoinPrice,
    lastTick: () => lastTick,
    isRunning: () => running,
    isStopped: () => stopped,
    noteFastWake: () => fastWakes++,
  };
}

/**
 * Runs a full check early when something worth acting on happens between the regular ones: every
 * cfg.fastMs it reads just the two USD pools' prices (two calls) and, every cfg.fastKucoinMs, KuCoin's,
 * and asks fastTriggerReason. An urgent reason (a pool moved 1%+) runs a check at once; a standing
 * gap/lag at most every cfg.fastMinSpacingMs. Never overlaps a check already running.
 */
export function startFastWatcher(bot, provider, cfg) {
  let busy = false;
  let kMid = null;
  let kAt = 0;
  let lastWake = 0;
  const triggerCfg = { ...FAST_DEFAULTS, movePct: cfg.fastMovePct, gapPct: cfg.gapMinGainPct, lagPct: cfg.cuLagPct };
  return setInterval(async () => {
    if (busy || bot.isRunning() || bot.isStopped()) return;
    busy = true;
    try {
      const mids = {};
      for (const [stable, p] of Object.entries(POOLS)) mids[stable] = await midPrice(provider, p);
      if (cfg.cuEnabled && Date.now() - kAt >= cfg.fastKucoinMs) {
        kMid = await bot.kucoinPrice();
        kAt = Date.now();
      }
      const hit = fastTriggerReason({ mids, kMid: cfg.cuEnabled ? kMid : null, last: bot.lastTick() }, triggerCfg);
      if (!hit || (!hit.urgent && Date.now() - lastWake < cfg.fastMinSpacingMs)) return;
      lastWake = Date.now();
      bot.noteFastWake();
      await bot.tick();
    } catch {
      // a missed read just waits for the next one; the regular check still runs on its own clock
    } finally {
      busy = false;
    }
  }, cfg.fastMs);
}

export async function startEtnAccumulatorBot() {
  if (process.env.ETN_BOT_ENABLED !== "true") {
    console.log("ℹ️  ETN_BOT_ENABLED not true — ETN accumulator bot disabled");
    return;
  }
  if (!botStateConfigured()) {
    console.log("ℹ️  R2 not configured — ETN accumulator bot disabled (it keeps its books there)");
    return;
  }
  const cfg = readConfig();
  const key = process.env.ETN_BOT_PRIVATE_KEY || process.env.BACKEND_PRIVATE_KEY;
  if (cfg.mode === "live" && !key) {
    console.log("ℹ️  ETN_BOT_MODE=live but no ETN_BOT_PRIVATE_KEY / BACKEND_PRIVATE_KEY — ETN accumulator bot disabled");
    return;
  }
  const provider = createRpcProvider();
  const wallet = key ? new ethers.Wallet(key, provider) : null;
  if (cfg.mode === "live") {
    // What the bot can actually have out of the wallet at once: up to maxStableFraction of the
    // budget in lots, plus the gap book's seed — not the whole budget.
    const needed = cfg.maxStableFraction * cfg.budgetEtn + (cfg.gapEnabled ? cfg.gapSeedEtn : 0) + cfg.gasReserveEtn;
    const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
    if (bal < needed) console.warn(`⚠️  ETN bot: wallet holds ${fmtEtn(bal)} ETN, below the ${fmtEtn(needed)} it may need at once (lots + gap seed + gas reserve) — trades will stop when the balance runs short`);
  }
  const gapText =
    (cfg.gapEnabled ? `; gap mode ON (seed ${fmtEtn(cfg.gapSeedEtn)} ETN, clip ${fmtEtn(cfg.gapClipEtn)}, min gain ${cfg.gapMinGainPct}%)` : "; gap mode off") +
    (cfg.triEnabled ? `; triangles ON (up to ${fmtEtn(cfg.triMaxEtn)} ETN, min gain ${cfg.triMinGainEtn} ETN)` : "; triangles off") +
    (cfg.hedgeLive ? `; HEDGING LIVE (${cfg.hedgeLagPct}%+ gap, up to $${cfg.hedgeMaxUsd}, max ${fmtEtn(cfg.hedgeMaxEtnOut)} ETN on the CEX side; round trip ${cfg.hedgeRebalance ? "ON" : "off"}; venues: ${Object.values(VENUES).filter((v) => v.configured()).map((v) => v.name).join(" + ") || "none"})` : cfg.hedgePaper ? "; hedging paper-only (KuCoin + HTX books)" : "") +
    (cfg.arbLive ? `; CEX ARB LIVE (KuCoin <-> HTX, ${cfg.arb.minEdgePct}%+ after fees, up to $${Math.max(...cfg.arb.sizesUsd)})` : cfg.arbPaper ? "; CEX arb paper-only" : "") +
    (cfg.profitFloorEtn > 0 ? `; profit floor ${fmtEtn(cfg.profitFloorEtn)} ETN` : "") +
    (cfg.cexRefill ? `; refills ON (HTX ETN < ${fmtEtn(cfg.refill.htxEtnLow)} -> ${fmtEtn(cfg.refill.htxEtnTarget)}, KuCoin USDT < $${cfg.refill.kucoinUsdtLow} -> $${cfg.refill.kucoinUsdtTarget})` : "") +
    (cfg.cuEnabled ? `; KuCoin catch-up ON (pot ${fmtUsd(cfg.cuPotUsd)}, lag ${cfg.cuLagPct}%, $${cfg.cuClipUsd} clips, min gain ${cfg.cuMinGainPct}%, sell side ${cfg.cuSellEnabled ? `ON up to ${fmtEtn(cfg.cuMaxSellEtn)} ETN` : "off"})` : "; KuCoin catch-up off");
  console.log(`🤖 ETN accumulator bot started — ${cfg.mode.toUpperCase()}, wallet ${wallet?.address ?? "(none, paper)"}, budget ${fmtEtn(cfg.budgetEtn)} ETN, clip ${fmtEtn(cfg.clipEtn)}, band +${cfg.sellBandPct}%, min gain ${cfg.minGainPct}%${gapText}, every ${cfg.intervalMs / 1000}s`);
  const bot = createEtnAccumulatorBot({ provider, wallet, cfg });
  bot.tick();
  const timers = [setInterval(() => bot.tick(), cfg.intervalMs)];
  // Render sends SIGTERM to the old instance during a deploy: stop trading at once and hand the lease over.
  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    console.log(`🤖 ETN bot: ${sig} — stopping (no new checks), then releasing the lease`);
    bot.stop().then((clean) => {
      console.log(`🤖 ETN bot: stopped${clean ? "" : " (a check was still running)"}, lease released`);
      // Listening for the signal replaced Node's default exit; keep that behaviour unless something else handles it.
      if (process.listenerCount(sig) === 0) process.exit(0);
    });
  };
  process.once("SIGTERM", () => onStop("SIGTERM"));
  process.once("SIGINT", () => onStop("SIGINT"));
  if (cfg.fastMs > 0) {
    timers.push(startFastWatcher(bot, provider, cfg));
    console.log(`⚡ ETN bot fast watcher on — pool prices every ${cfg.fastMs / 1000}s${cfg.cuEnabled ? `, KuCoin every ${cfg.fastKucoinMs / 1000}s` : ""}; checks early on a ${cfg.fastMovePct}%+ pool move, a ${cfg.gapMinGainPct}%+ pool gap${cfg.cuEnabled ? ` or ${cfg.cuLagPct}%+ off KuCoin` : ""}`);
  }
}
