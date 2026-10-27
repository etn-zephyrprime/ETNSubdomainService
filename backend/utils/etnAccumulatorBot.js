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
import { getBotState, setBotState, botStateConfigured } from "../state/etnAccumulatorBotState.js";
import { DEFAULT_CONFIG, updateEma, decide, applySell, applyBuyback, botEtnInventory } from "../services/etnAccumulatorStrategy.js";
import { GAP_DEFAULTS, gapSizes, affordableLegEtn, decideGap, freshGapBook, applyGapSellLeg, applyGapBuyLeg, applyGapDeposit } from "../services/etnGapStrategy.js";
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
export function createEtnAccumulatorBot({ provider, wallet, cfg, store = { get: getBotState, set: setBotState } }) {
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
  let pausedReason = null;
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
      await router.multicall.staticCall(deadline, calls, { value: inRaw });
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
    await router.multicall.staticCall(deadline, calls);
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
      notify(`❌ ${pending.kind} tx ${pending.txHash} reverted.`);
      return "failed";
    }
    const amounts = pending.kind === "triangle" ? triangleAmounts(receipt) : swapAmounts(receipt, POOLS[pending.stable]);
    if (!amounts) throw new Error(`No Swap event in ${pending.txHash}`); // left pending — needs a look, not a guess
    state.pending = null;
    consecutiveFailures = 0;
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
    await router.multicall.staticCall(deadline, calls, { value: amountIn });
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
    const gap = state.gap;
    for (const [k, p] of Object.entries(POOLS)) {
      const held = Number(ethers.formatUnits(await new ethers.Contract(p.token, ERC20_ABI, provider).balanceOf(wallet.address), p.decimals));
      const inLots = state.lots.filter((l) => l.status === "open" && l.stable === k).reduce((s, l) => s + l.stableAmount, 0);
      const diff = held - inLots - (gap.stables[k] || 0);
      if (Math.abs(diff) < 0.01) continue;
      applyGapDeposit(gap, k, diff, diff / mids[k]);
      notify(diff > 0
        ? `💵 ${fmtUsd(diff)} ${k} found in the wallet — added to the gap book (now ${fmtUsd(gap.stables[k])} ${k})`
        : `⚠️ ${fmtUsd(-diff)} ${k} missing from the wallet — gap book reduced to ${fmtUsd(gap.stables[k])} ${k}`);
    }
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
    if (running || pausedReason) return;
    running = true;
    try {
      const state = (await store.get(cfg.mode)) || freshState(cfg);
      if (state.budgetEtn !== cfg.budgetEtn) {
        console.log(`🤖 ETN bot: budget ${state.budgetEtn} -> ${cfg.budgetEtn} ETN (ETN_BOT_BUDGET_ETN changed)`);
        state.budgetEtn = cfg.budgetEtn;
      }
      if (cfg.gapEnabled && !state.gap) state.gap = freshGapBook();
      if (cfg.triEnabled && !state.tri) state.tri = freshTriangleBook();

      // A trade still in flight from a previous tick/process: settle it before anything else.
      if (state.pending) {
        const result = await resolvePending(state);
        await saveWithRetry(state);
        if (result === "waiting") return;
      }
      // A gap trade whose second leg hasn't run (a failure or restart between the legs): finish it first.
      if (state.gapLeg) {
        await completeGapLeg(state);
        await saveWithRetry(state);
        return;
      }

      // Price EMA (mid of both pools).
      const mids = {};
      for (const [stable, p] of Object.entries(POOLS)) mids[stable] = await midPrice(provider, p);
      const mid = (mids.USDT + mids.USDC) / 2;
      const now = Date.now();
      state.ema = updateEma(state.ema, mid, state.emaAt ? now - new Date(state.emaAt).getTime() : 0, cfg.emaHalfLifeHours * 3600000);
      state.emaAt = new Date(now).toISOString();
      state.samples = (state.samples || 0) + 1;

      // USDT/USDC you send to the wallet joins the gap book (live only; see reconcileGapStables).
      if (cfg.gapEnabled && cfg.mode === "live" && wallet) await reconcileGapStables(state, mids);

      const quotes = await gatherQuotes(provider, state, cfg.clipEtn);
      if (wallet) {
        const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
        quotes.walletEtn = bal - cfg.gasReserveEtn;
      }
      const decision = decide(state, quotes, cfg);
      const inventory = botEtnInventory(state);
      const canSpendEtn = (etn) => inventory >= etn && (quotes.walletEtn == null || quotes.walletEtn >= etn);

      const day = new Date().toISOString().slice(0, 10);
      state.tradesByDay = { [day]: state.tradesByDay?.[day] || 0 }; // keep today only
      state.gapTradesByDay = { [day]: state.gapTradesByDay?.[day] || 0 };
      state.triTradesByDay = { [day]: state.triTradesByDay?.[day] || 0 };
      const lotCapHit = state.tradesByDay[day] >= cfg.maxTradesPerDay;

      // 1. Lot buybacks — they lock in ETN.
      if (decision.action === "buyback" && !lotCapHit) {
        state.tradesByDay[day]++;
        await execute(state, { kind: "buyback", side: "buyEtn", stable: decision.stable, amountIn: decision.stableAmount, expectedOut: decision.expectedEtn, lotId: decision.lotId });
        await saveWithRetry(state);
        return;
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
      if (decision.action === "sell" && !lotCapHit) {
        state.tradesByDay[day]++;
        await execute(state, { kind: "sell", side: "sellEtn", stable: decision.stable, amountIn: decision.etnAmount, expectedOut: decision.expectedStable, lotId: state.nextLotId++ });
        await saveWithRetry(state);
        return;
      }

      const reason = decision.action === "hold" ? decision.reason : `daily trade cap (${cfg.maxTradesPerDay}) reached`;
      if (state.samples % 30 === 1) console.log(`🤖 ETN bot: hold — ${reason} (mid ${mid.toPrecision(4)}, EMA ${state.ema.toPrecision(4)}, inventory ${fmtEtn(inventory)} ETN)${gapNote}${triNote}`);
      await saveWithRetry(state);
    } catch (err) {
      console.error("⚠️  ETN bot tick failed:", err.shortMessage || err.message);
    } finally {
      running = false;
      if (consecutiveFailures >= 3 && !pausedReason) {
        pausedReason = "3 failed trades in a row";
        notify(`⏸️ Paused: ${pausedReason}. Restart the service to resume.`);
      }
    }
  }

  return { tick };
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
    (cfg.triEnabled ? `; triangles ON (up to ${fmtEtn(cfg.triMaxEtn)} ETN, min gain ${cfg.triMinGainEtn} ETN)` : "; triangles off");
  console.log(`🤖 ETN accumulator bot started — ${cfg.mode.toUpperCase()}, wallet ${wallet?.address ?? "(none, paper)"}, budget ${fmtEtn(cfg.budgetEtn)} ETN, clip ${fmtEtn(cfg.clipEtn)}, band +${cfg.sellBandPct}%, min gain ${cfg.minGainPct}%${gapText}, every ${cfg.intervalMs / 1000}s`);
  const bot = createEtnAccumulatorBot({ provider, wallet, cfg });
  bot.tick();
  setInterval(() => bot.tick(), cfg.intervalMs);
}
