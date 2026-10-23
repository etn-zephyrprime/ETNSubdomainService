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
// Money safety:
//   - The bot only ever spends its own books: budget ETN (ETN_BOT_BUDGET_ETN) less what's out in
//     open lots, and each open lot's own stablecoin. The wallet's other ETN is never touched, so it
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
import { DEFAULT_CONFIG, updateEma, decide, applySell, applyBuyback, summarize, botEtnInventory } from "../services/etnAccumulatorStrategy.js";

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
  };
}

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const ROUTER_ABI = [
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
const routerIface = new ethers.Interface(ROUTER_ABI);

const fmtEtn = (n) => Math.round(n).toLocaleString("en-US");
const fmtUsd = (n) => `$${n.toFixed(2)}`;

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
 * signed from the pool's side (negative = paid out to us). */
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

/** Applies a mined pending trade's receipt to the books. */
function settlePending(state, pending, receipt) {
  const p = POOLS[pending.stable];
  const at = new Date().toISOString();
  if (receipt.status !== 1) return { ok: false };
  const amounts = swapAmounts(receipt, p);
  if (!amounts) throw new Error(`No Swap event in ${pending.txHash}`);
  if (pending.kind === "sell") {
    applySell(state, { id: pending.lotId, stable: pending.stable, etnSold: amounts.etnDelta, stableAmount: -amounts.stableDelta, txHash: pending.txHash, at });
  } else {
    applyBuyback(state, pending.lotId, { etnBought: -amounts.etnDelta, txHash: pending.txHash, at });
  }
  return { ok: true };
}

export function createEtnAccumulatorBot({ provider, wallet, cfg }) {
  async function saveWithRetry(state) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await setBotState(cfg.mode, state);
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

  async function sendSell(state, decision, lotId) {
    const p = POOLS[decision.stable];
    const amountIn = ethers.parseEther(String(decision.etnAmount));
    const minOut = (ethers.parseUnits(decision.expectedStable.toFixed(p.decimals), p.decimals) * BigInt(10000 - cfg.slippageBps)) / 10000n;
    const router = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
    const calls = [
      routerIface.encodeFunctionData("exactInputSingle", [{ tokenIn: WETN, tokenOut: p.token, fee: p.fee, recipient: wallet.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]),
      routerIface.encodeFunctionData("refundETH", []),
    ];
    const deadline = Math.floor(Date.now() / 1000) + 300;
    await router.multicall.staticCall(deadline, calls, { value: amountIn });
    const tx = await router.multicall(deadline, calls, { value: amountIn });
    return { kind: "sell", lotId, stable: decision.stable, txHash: tx.hash, nonce: tx.nonce, sentAt: new Date().toISOString() };
  }

  async function sendBuyback(decision) {
    const p = POOLS[decision.stable];
    const amountIn = ethers.parseUnits(decision.stableAmount.toFixed(p.decimals), p.decimals);
    const minOut = (ethers.parseEther(decision.expectedEtn.toFixed(18)) * BigInt(10000 - cfg.slippageBps)) / 10000n;
    const token = new ethers.Contract(p.token, ERC20_ABI, wallet);
    const held = await token.balanceOf(wallet.address);
    if (held < amountIn) throw new Error(`wallet holds ${ethers.formatUnits(held, p.decimals)} ${decision.stable}, lot needs ${decision.stableAmount}`);
    if ((await token.allowance(wallet.address, SWAP_ROUTER)) < amountIn) {
      await (await token.approve(SWAP_ROUTER, amountIn)).wait(); // exact amount, never unlimited
    }
    const router = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
    const calls = [
      routerIface.encodeFunctionData("exactInputSingle", [{ tokenIn: p.token, tokenOut: WETN, fee: p.fee, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]),
      routerIface.encodeFunctionData("unwrapWETH9", [minOut, wallet.address]),
    ];
    const deadline = Math.floor(Date.now() / 1000) + 300;
    await router.multicall.staticCall(deadline, calls);
    const tx = await router.multicall(deadline, calls);
    return { kind: "buyback", lotId: decision.lotId, stable: decision.stable, txHash: tx.hash, nonce: tx.nonce, sentAt: new Date().toISOString() };
  }

  async function resolvePending(state) {
    const pending = state.pending;
    const receipt = await provider.getTransactionReceipt(pending.txHash);
    if (!receipt) {
      // Dropped for certain only once the wallet's mined nonce has moved past this tx's own (a
      // timeout alone could clear a sale that still mines later, losing track of its stablecoin).
      const minedNonce = await provider.getTransactionCount(wallet.address, "latest");
      if (pending.nonce != null && minedNonce > pending.nonce) {
        const again = await provider.getTransactionReceipt(pending.txHash);
        if (!again) {
          state.pending = null;
          notify(`⚠️ ${pending.kind} tx ${pending.txHash} was dropped (nonce ${pending.nonce} used by another tx); cleared.`);
          return true;
        }
        return resolvePending(state);
      }
      return false; // still waiting
    }
    const { ok } = settlePending(state, pending, receipt);
    state.pending = null;
    if (!ok) {
      consecutiveFailures++;
      notify(`❌ ${pending.kind} tx ${pending.txHash} reverted.`);
    } else {
      consecutiveFailures = 0;
      const lot = state.lots.find((l) => l.id === pending.lotId);
      const s = summarize(state);
      notify(
        pending.kind === "sell"
          ? `🔴 Sold ${fmtEtn(lot.etnSold)} ETN for ${fmtUsd(lot.stableAmount)} ${lot.stable} at ${lot.sellPrice.toPrecision(4)} (lot #${lot.id})`
          : `🟢 Bought back ${fmtEtn(lot.etnBought)} ETN for ${fmtUsd(lot.stableAmount)} ${lot.stable} — +${fmtEtn(lot.etnBought - lot.etnSold)} ETN (lot #${lot.id}). Realized so far: +${fmtEtn(s.realizedGainEtn)} ETN over ${s.cyclesClosed} cycle(s)`
      );
    }
    return true;
  }

  async function tick() {
    if (running || pausedReason) return;
    running = true;
    try {
      const state = (await getBotState(cfg.mode)) || freshState(cfg);
      if (state.budgetEtn !== cfg.budgetEtn) {
        console.log(`🤖 ETN bot: budget ${state.budgetEtn} -> ${cfg.budgetEtn} ETN (ETN_BOT_BUDGET_ETN changed)`);
        state.budgetEtn = cfg.budgetEtn;
      }

      // A trade still in flight from a previous tick/process: settle it before anything else.
      if (state.pending) {
        const settled = await resolvePending(state);
        await setBotState(cfg.mode, state);
        if (!settled) return;
      }

      // Price EMA (mid of both pools).
      const mids = await Promise.all(Object.values(POOLS).map((p) => midPrice(provider, p)));
      const mid = mids.reduce((a, b) => a + b, 0) / mids.length;
      const now = Date.now();
      state.ema = updateEma(state.ema, mid, state.emaAt ? now - new Date(state.emaAt).getTime() : 0, cfg.emaHalfLifeHours * 3600000);
      state.emaAt = new Date(now).toISOString();
      state.samples = (state.samples || 0) + 1;

      const quotes = await gatherQuotes(provider, state, cfg.clipEtn);
      if (wallet) {
        const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
        quotes.walletEtn = bal - cfg.gasReserveEtn;
      }
      const decision = decide(state, quotes, cfg);

      const day = new Date().toISOString().slice(0, 10);
      state.tradesByDay = { [day]: state.tradesByDay?.[day] || 0 }; // keep today only
      if (decision.action !== "hold" && state.tradesByDay[day] >= cfg.maxTradesPerDay) {
        decision.action = "hold";
        decision.reason = `daily trade cap (${cfg.maxTradesPerDay}) reached`;
      }

      if (decision.action === "hold") {
        if (state.samples % 30 === 1) console.log(`🤖 ETN bot: hold — ${decision.reason} (mid ${mid.toPrecision(4)}, EMA ${state.ema.toPrecision(4)}, inventory ${fmtEtn(botEtnInventory(state))} ETN)`);
        await setBotState(cfg.mode, state);
        return;
      }

      state.tradesByDay[day]++;
      if (cfg.mode === "paper") {
        const at = new Date().toISOString();
        if (decision.action === "sell") {
          applySell(state, { id: state.nextLotId++, stable: decision.stable, etnSold: decision.etnAmount, stableAmount: decision.expectedStable, txHash: null, at });
          notify(`🔴 Sold ${fmtEtn(decision.etnAmount)} ETN for ${fmtUsd(decision.expectedStable)} ${decision.stable} at ${decision.price.toPrecision(4)} (EMA ${state.ema.toPrecision(4)})`);
        } else {
          const lot = state.lots.find((l) => l.id === decision.lotId);
          applyBuyback(state, decision.lotId, { etnBought: decision.expectedEtn, txHash: null, at });
          notify(`🟢 Bought back ${fmtEtn(decision.expectedEtn)} ETN for ${fmtUsd(lot.stableAmount)} ${lot.stable} — +${fmtEtn(decision.expectedEtn - lot.etnSold)} ETN (+${decision.gainPct.toFixed(1)}%)`);
        }
        await setBotState(cfg.mode, state);
        return;
      }

      // Live.
      try {
        state.pending = decision.action === "sell" ? await sendSell(state, decision, state.nextLotId++) : await sendBuyback(decision);
      } catch (err) {
        consecutiveFailures++;
        await setBotState(cfg.mode, state);
        throw err;
      }
      await saveWithRetry(state); // record the in-flight tx before waiting on it — a lost write here would lose the lot
      await provider.waitForTransaction(state.pending.txHash, 1, 120000).catch(() => null);
      await resolvePending(state);
      await setBotState(cfg.mode, state);
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
    const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
    if (bal < cfg.budgetEtn + cfg.gasReserveEtn) console.warn(`⚠️  ETN bot: wallet holds ${fmtEtn(bal)} ETN, below budget ${fmtEtn(cfg.budgetEtn)} + reserve ${cfg.gasReserveEtn} — sales will stop when the balance runs short`);
  }
  console.log(`🤖 ETN accumulator bot started — ${cfg.mode.toUpperCase()}, wallet ${wallet?.address ?? "(none, paper)"}, budget ${fmtEtn(cfg.budgetEtn)} ETN, clip ${fmtEtn(cfg.clipEtn)}, band +${cfg.sellBandPct}%, min gain ${cfg.minGainPct}%, every ${cfg.intervalMs / 1000}s`);
  const bot = createEtnAccumulatorBot({ provider, wallet, cfg });
  bot.tick();
  setInterval(() => bot.tick(), cfg.intervalMs);
}
