// backend/utils/coreClashSwapWatcher.js
//
// Ported from CoreClashGame/backend/swapListener.js — but as a purpose-built CORE/WETN watcher,
// not a line-for-line port of the original's general multi-token/multi-DEX aggregation engine.
// That generality is currently unused: swapsConfig.js's TRACKED_TOKENS has every entry except
// CORE commented out, and the multi-leg dedup/aggregation machinery only exists to handle tokens
// that aren't tracked today. Porting it as-is would mean maintaining ~500 lines that do nothing
// but stand ready for tokens nobody has turned on.
//
// Also NOT ported: the "ALL_SWAPS"/general-alerts messages via `sendSwapMessage()` — that
// function is referenced in swapListener.js but its only definition is commented out in
// telegramBot.js, so those two call sites have been throwing (caught, but throwing) on every
// single swap in production already. Not something to carry forward; worth fixing at the source
// separately if still wanted.
//
// What *is* preserved exactly: the CORE-specific "actual taxed amount" correction (CORE takes a
// tax on transfer, so the swap event's raw amounts overstate what the trader actually
// received/sent — corrected here the same way, by reading the ERC20 Transfer logs in the same
// receipt), the same USD-value thresholds gating which swaps get announced (BUY: $5-$50, SELL:
// >$20), and the same message content/formatting posted to the Zephyros bot's general topic.
//
// SWAP DISCOVERY: purely on-chain. Each poll asks the RPC node for the watched pool's own `Swap`
// events since the last block it processed (a few blocks' worth at the default 60s cadence) and
// announces each one — see poll() below. This used to ask ElectroSwap's /trades endpoint first
// ("which tx hashes are recent CORE trades?") and read the actual amounts from the receipt, but that
// cost ~500 credits every poll (~720k credits/day) to learn about the ~3 swaps a day this pool sees:
// ~99.8% of paid polls came back with nothing new. It was also redundant — the only thing ever done
// with a discovered trade was to read THIS pool's Swap log out of its receipt, i.e. exactly what the
// getLogs query returns directly. Polling cadence is unchanged. (Nothing else in the app stopped
// using ElectroSwap: prices, charts, locks, liquidity etc. are untouched.)
//
// seenTradeHashes is still kept, now as a dedup on the on-chain path: it stops a trade that the
// previous ElectroSwap-based version announced in the last couple of blocks (above the reorg buffer)
// from being announced a second time when this version rescans that range, and guards a reorg replay.
import { ethers } from "ethers";
import { getState, setState } from "../state/coreClashState.js";
import { sendZephyrosAnimation, sendZephyrosMessage, escapeHtml, zephyrosBotConfigured, GENERAL_THREAD_ID } from "./coreClashTelegram.js";
import {
  EXPLORER_BASE_URL,
  CORE_TOKEN_ADDRESS,
  CORE_WETN_POOL_ADDRESS,
  REVERSE_REGISTRAR_ADDRESS,
  WETN_ADDRESS,
  SWAP_POLL_INTERVAL_MS,
  LOOKBACK_BLOCKS,
} from "./coreClashConfig.js";
import { createRpcProvider } from "./rpcProvider.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { getCachedTokenPrice } from "./electroSwapPriceCache.js";

const STATE_KEY = "swap-watcher";
const MAX_BLOCK_RANGE = 500;
const REORG_BUFFER_BLOCKS = 2;
// Same cadence as priceEngine.js's PRICE_REFRESH_MS — independent of swap activity, so CORE/WETN
// pricing stays current even through a quiet period with no trades, and so a burst of swaps in
// one poll tick doesn't mean a shared-cache read once per trade.
const PRICE_REFRESH_MS = 5 * 60 * 1000;
// CoreClashGame's swapsConfig.js "zephyrosAnimationFileId" for CORE — same reasoning as the burn
// watcher's file_id: bot-scoped, still valid via the same Zephyros bot token.
const BUY_ANIMATION_FILE_ID = "CgACAgQAAxkBAAMFageBD-eZV-B_uGg2Y72GurOfNFoAApgeAAL9hyhTCD9skqLLhrY7BA";

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const ERC20_TRANSFER_IFACE = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const SWAP_TOPIC = new ethers.Interface(PAIR_ABI).getEvent("Swap").topicHash;

function formatUnitsSafe(value, decimals) {
  try {
    return Number(ethers.formatUnits(value, decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  } catch {
    return value.toString();
  }
}

async function fetchWetnUsd() {
  // Reads etnPriceCache.js's own published price instead of calling CoinGecko directly a second
  // time. Found live (a real 429 in production) that this and etnPriceCache.js were independently
  // polling the exact same CoinGecko endpoint on the exact same 5-minute cadence, both started
  // from the same app.listen() callback — meaning every ~5 minutes this backend made two
  // near-simultaneous identical requests for data that's already published in one place for
  // exactly this reason (see etnPriceState.js's own comment: "instead of every visitor's browser
  // hitting CoinGecko directly" — the same logic applies to this backend's own internal callers).
  // R2 reads aren't meaningfully rate-limited the way CoinGecko's free API is, so this halves the
  // CoinGecko call volume for this price with no loss of freshness (etnPriceCache.js refreshes on
  // the same 5-minute cadence this file used to poll CoinGecko on directly).
  try {
    const cached = await getEtnPriceCache();
    if (cached?.usd && Number.isFinite(cached.usd) && cached.usd > 0) return cached.usd;
  } catch (err) {
    console.warn("⚠️  [SwapWatcher] Failed to read shared ETN price cache, using fallback price:", err.message);
  }
  return 0.00103; // same fallback etnPriceCache.js uses when R2 itself has nothing published yet
}

// Cached, periodically-refreshed prices — same design as priceEngine.js: both the trade's own
// USD-value estimate and the "CORE Price" line in the message read from this cache rather than
// hitting CoinGecko/RPC on every single swap.
let cachedWetnUsd = null;
let cachedCorePriceUsd = null;
let lastPriceRefreshMs = 0;

async function refreshPrices(pair, coreIsToken0, coreDecimals) {
  const wetnUsd = await fetchWetnUsd();
  cachedWetnUsd = wetnUsd;

  // ElectroSwap first — same "try ElectroSwap, fall back to on-chain" pattern every other live-
  // price call site in this app uses (see dexPriceQuote.js's own header comment) — through
  // electroSwapPriceCache.js's shared cache, so this doesn't pay for its own dedicated call every
  // single 5-minute refresh if some OTHER consumer (e.g. tokenPriceAlertScheduler.js, if a member
  // happens to have an active price alert on CORE) already priced it within the last ~90s. Real
  // savings only when that overlap happens — most 5-minute ticks still pay their own credit cost
  // here if nothing else is pricing CORE on a similar cadence; see electroSwapPriceCache.js's own
  // header comment on why that's an honest, opportunistic saving, not a free feed.
  const electroSwapPrice = await getCachedTokenPrice(CORE_TOKEN_ADDRESS).catch((err) => {
    console.warn("⚠️  [SwapWatcher] ElectroSwap price lookup failed for CORE:", err.message);
    return null;
  });
  if (electroSwapPrice?.usd != null) {
    cachedCorePriceUsd = electroSwapPrice.usd;
    lastPriceRefreshMs = Date.now();
    console.log(`💱 Prices refreshed — WETN $${wetnUsd.toFixed(6)}, CORE $${cachedCorePriceUsd.toFixed(6)} (ElectroSwap)`);
    return;
  }

  // Fallback: direct on-chain pool-reserve read — unchanged from the original method, used when
  // ElectroSwap doesn't have CORE priced (or ELECTROSWAP_API_KEY isn't set at all).
  try {
    const [reserve0, reserve1] = await pair.getReserves();
    const coreReserveRaw = coreIsToken0 ? reserve0 : reserve1;
    const wetnReserveRaw = coreIsToken0 ? reserve1 : reserve0;

    const coreReserve = Number(ethers.formatUnits(coreReserveRaw, coreDecimals));
    const wetnReserve = Number(ethers.formatUnits(wetnReserveRaw, 18));

    if (coreReserve > 0 && wetnReserve > 0) {
      cachedCorePriceUsd = (wetnReserve / coreReserve) * wetnUsd;
    }
  } catch (err) {
    console.warn("⚠️  [SwapWatcher] Failed to read pool reserves for CORE price:", err.message);
  }

  lastPriceRefreshMs = Date.now();
  console.log(
    `💱 Prices refreshed — WETN $${wetnUsd.toFixed(6)}` +
      (cachedCorePriceUsd != null ? `, CORE $${cachedCorePriceUsd.toFixed(6)} (on-chain reserves)` : ", CORE price unavailable")
  );
}

// Reads the actual CORE amount transferred to/from the trader in this tx's receipt — CORE taxes
// transfers, so the pool's own Swap event amounts overstate what the trader actually got/paid.
function actualTaxedAmount(receipt, trader, side) {
  const traderLc = trader.toLowerCase();
  let actual = 0n;

  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== CORE_TOKEN_ADDRESS.toLowerCase()) continue;
    if (log.topics?.[0] !== TRANSFER_TOPIC) continue;

    try {
      const parsed = ERC20_TRANSFER_IFACE.parseLog(log);
      const from = String(parsed.args.from).toLowerCase();
      const to = String(parsed.args.to).toLowerCase();
      const value = BigInt(parsed.args.value);

      if (side === "BUY" && to === traderLc) actual += value;
      if (side === "SELL" && from === traderLc) actual += value;
    } catch {
      // ignore unrelated/bad logs
    }
  }

  return actual > 0n ? actual : null;
}

let isPolling = false;

// The actual "read one Swap log, correct for CORE's transfer tax, check USD thresholds, post the
// message" logic — unchanged from before, just factored out so both discovery paths below
// (ElectroSwap fast-path and the getLogs fallback) can share it. Nothing here cares which path
// found `log`, only that it's a real Swap event log from CORE_WETN_POOL_ADDRESS.
async function processSwapLog(ctx, log, wetnUsd) {
  const { provider, pair, coreIsToken0, coreDecimals, coreSymbol, resolveDisplayName } = ctx;

  const parsed = pair.interface.parseLog(log);
  const { amount0In, amount1In, amount0Out, amount1Out, to } = parsed.args;

  const coreIn = coreIsToken0 ? amount0In : amount1In;
  const coreOut = coreIsToken0 ? amount0Out : amount1Out;
  const wetnIn = coreIsToken0 ? amount1In : amount0In;
  const wetnOut = coreIsToken0 ? amount1Out : amount0Out;

  const isSell = coreIn > 0n; // trader sent CORE into the pool
  const rawCoreAmount = isSell ? coreIn : coreOut;
  const rawWetnAmount = isSell ? wetnOut : wetnIn;
  if (rawCoreAmount <= 0n) return;

  const tx = await provider.getTransaction(log.transactionHash);
  const receipt = await provider.getTransactionReceipt(log.transactionHash);
  const trader = tx?.from || to;

  const corrected = actualTaxedAmount(receipt, trader, isSell ? "SELL" : "BUY");
  const coreAmountRaw = corrected ?? rawCoreAmount;

  const wetnAmountFloat = Number(ethers.formatUnits(rawWetnAmount, 18));
  const usdValue = wetnAmountFloat * wetnUsd;
  // The maintained reference price (refreshed every PRICE_REFRESH_MS from pool reserves), not
  // derived from this specific trade — matches priceEngine.js's getTokenUsd(), which is what the
  // original's "CORE Price:" line reads from.
  const corePriceUsd = cachedCorePriceUsd;

  const shouldSend = isSell ? usdValue > 20 : usdValue > 5 && usdValue < 50;
  if (!shouldSend) return;

  const txUrl = `${EXPLORER_BASE_URL}/tx/${log.transactionHash}`;
  const traderUrl = `${EXPLORER_BASE_URL}/address/${trader}`;
  const traderDisplay = await resolveDisplayName(trader);
  const emojiSequence = isSell ? ["🌎", "🌳"] : ["🌳", "🌎"];
  const emojiCount = Math.min(Math.max(1, Math.floor(usdValue / 5)), 50);
  const emojiLine = Array.from({ length: emojiCount }, (_, i) => emojiSequence[i % emojiSequence.length]).join("");

  const caption =
    `<b>CORE ${isSell ? "SELL" : "BUY"}</b> ($${usdValue.toFixed(2)})\n` +
    `${emojiLine}\n\n` +
    `💰 <b>${isSell ? "Received" : "Paid"}:</b> ${formatUnitsSafe(rawWetnAmount, 18)} WETN\n` +
    `🔢 <b>Amount:</b> ${formatUnitsSafe(coreAmountRaw, coreDecimals)} ${escapeHtml(coreSymbol)}\n` +
    (corePriceUsd != null ? `💵 <b>CORE Price:</b> $${corePriceUsd.toFixed(6)}\n` : "") +
    `\n👤 <b>Buyer:</b> <a href="${traderUrl}">${escapeHtml(traderDisplay)}</a>\n` +
    `🔗 <a href="${txUrl}">View Transaction</a>`;

  if (!isSell) {
    await sendZephyrosAnimation(BUY_ANIMATION_FILE_ID, caption, { threadId: GENERAL_THREAD_ID });
  } else {
    await sendZephyrosMessage(caption, { threadId: GENERAL_THREAD_ID });
  }

  console.log(`💱 Swap alert sent: ${isSell ? "SELL" : "BUY"} $${usdValue.toFixed(2)} (tx ${log.transactionHash})`);
}

// Kept across polls in persisted state (STATE_KEY's own seenTradeHashes), capped well past any
// realistic number of swaps in the reorg-buffer window, so a slow tick, a transient failure or a reorg
// can't reintroduce an already-announced trade as "new".
const MAX_SEEN_TRADE_HASHES = 200;


async function poll(ctx) {
  if (isPolling) return;
  isPolling = true;

  try {
    const { provider, pair, coreIsToken0, coreDecimals } = ctx;

    // Runs every poll tick regardless of swap activity — same as priceEngine.js's placement
    // outside the log-scanning block, so a quiet period doesn't leave prices stale.
    if (Date.now() - lastPriceRefreshMs > PRICE_REFRESH_MS) {
      await refreshPrices(pair, coreIsToken0, coreDecimals).catch((err) =>
        console.error("⚠️  [SwapWatcher] Price refresh failed:", err.message)
      );
    }

    const wetnUsd = cachedWetnUsd ?? (await fetchWetnUsd());
    const latestBlock = await provider.getBlockNumber();
    const safeBlock = Math.max(0, latestBlock - REORG_BUFFER_BLOCKS);

    const saved = await getState(STATE_KEY);
    const seenTradeHashes = saved?.seenTradeHashes ? [...saved.seenTradeHashes] : [];
    const seen = new Set(seenTradeHashes.map((h) => String(h).toLowerCase()));
    const announcedThisPoll = new Set();

    let fromBlock = saved?.lastBlock ?? null;

    if (fromBlock == null) {
      fromBlock = Math.max(0, safeBlock - LOOKBACK_BLOCKS) - 1;
      console.log(`💱 Swap watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (safeBlock <= fromBlock) {
      await setState(STATE_KEY, { lastBlock: fromBlock, seenTradeHashes });
      return;
    }

    let start = fromBlock + 1;
    while (start <= safeBlock) {
      const end = Math.min(start + MAX_BLOCK_RANGE - 1, safeBlock);
      const logs = await provider.getLogs({ address: CORE_WETN_POOL_ADDRESS, topics: [SWAP_TOPIC], fromBlock: start, toBlock: end });

      for (const log of logs) {
        const txKey = String(log.transactionHash).toLowerCase();
        // Already announced by a PREVIOUS poll (the ElectroSwap-based version just before this shipped,
        // or before a reorg replay). `seen` is the persisted set from before this poll started, so a
        // tx holding more than one Swap log for this pool is still fully announced in the poll that
        // first sees it.
        if (seen.has(txKey)) continue;
        try {
          await processSwapLog(ctx, log, wetnUsd);
          announcedThisPoll.add(txKey);
        } catch (err) {
          console.error("⚠️  Failed to process swap log:", err.message);
        }
      }

      start = end + 1;
    }

    // Remember what this poll announced (newest last), capped.
    const updated = [...seenTradeHashes, ...[...announcedThisPoll].filter((h) => !seen.has(h))].slice(-MAX_SEEN_TRADE_HASHES);
    await setState(STATE_KEY, { lastBlock: safeBlock, seenTradeHashes: updated });
  } catch (err) {
    console.error("⚠️  Swap watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

export async function startCoreClashSwapWatcher() {
  if (!CORE_TOKEN_ADDRESS) {
    console.log("ℹ️  CORE_TOKEN_ADDRESS not set — Core Clash swap watcher disabled");
    return;
  }
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros bot not configured — Core Clash swap watcher disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as marketplaceWatcher.js; this provider now also resolves the
  // trader's primary name via primaryNameResolver.js.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const pair = new ethers.Contract(CORE_WETN_POOL_ADDRESS, PAIR_ABI, provider);
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  const [token0, token1] = await Promise.all([pair.token0(), pair.token1()]);
  const coreIsToken0 = String(token0).toLowerCase() === CORE_TOKEN_ADDRESS.toLowerCase();
  const coreIsToken1 = String(token1).toLowerCase() === CORE_TOKEN_ADDRESS.toLowerCase();

  if (!coreIsToken0 && !coreIsToken1) {
    console.error(`⚠️  CORE_WETN_POOL_ADDRESS ${CORE_WETN_POOL_ADDRESS} doesn't contain CORE_TOKEN_ADDRESS ${CORE_TOKEN_ADDRESS} — Core Clash swap watcher disabled`);
    return;
  }

  const wetnTokenAddress = coreIsToken0 ? token1 : token0;
  if (String(wetnTokenAddress).toLowerCase() !== WETN_ADDRESS.toLowerCase()) {
    console.warn(`⚠️  Pool's other token (${wetnTokenAddress}) isn't the expected WETN address (${WETN_ADDRESS}) — continuing anyway, but USD estimates assume WETN pricing`);
  }

  const coreToken = new ethers.Contract(CORE_TOKEN_ADDRESS, ERC20_ABI, provider);
  let coreSymbol = "CORE";
  let coreDecimals = 18;
  try {
    [coreSymbol, coreDecimals] = await Promise.all([coreToken.symbol(), coreToken.decimals()]);
  } catch (err) {
    console.warn("⚠️  Failed to read CORE token metadata, using defaults:", err.message);
  }

  const ctx = { provider, pair, coreIsToken0, coreDecimals, coreSymbol, resolveDisplayName };

  console.log(
    `💱 Core Clash swap watcher started (polling every ${SWAP_POLL_INTERVAL_MS / 1000}s, on-chain discovery — no ElectroSwap calls)`
  );
  poll(ctx);
  setInterval(() => poll(ctx), SWAP_POLL_INTERVAL_MS);
}
