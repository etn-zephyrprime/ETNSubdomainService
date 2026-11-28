// backend/utils/tapCore.js
//
// Shared by the Telegram and Discord tap bots: one wallet, one send queue (so the two bots never
// collide on nonces), gas accounting, and the display helpers both bots use.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { setTapGas } from "../db/tapBotTaps.js";
import { prizeTreasure } from "./tapHunt.js";

export const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
export const TAP_GAS_LIMIT = 21000n;
export const MILESTONE_EVERY = 1000;
export const FLAIR_CHANCE = 0.2;
export const FUEL_FULL_ETN = Number(process.env.TAP_FUEL_FULL_ETN || 100);
export const MENU_TEXT = "Tap to burn a little ETN, or donate to keep the taps going.";

/** Menu text, with the treasure hunt section and live treasure balance when the hunt is configured. Plain text, safe for Telegram and Discord. */
export async function menuText() {
  const treasure = await prizeTreasure(getTapContext().provider);
  if (!treasure) return MENU_TEXT;
  return [
    MENU_TEXT,
    "",
    "🏴‍☠️ TREASURE HUNT",
    "Taps can reveal words from a secret 24-word seed phrase. Collect them all and work out the order to unlock the treasure wallet.",
    `💰 Current treasure: ${treasure}`,
    "",
    "How to start:",
    "1. Tap 🔥 and watch for a 📜 sentence in the tap message.",
    "2. Each word you find is sent to you privately. Keep track of them there.",
    "3. Collect all 24 words and work out their order yourself.",
    "4. Import the phrase into a wallet to claim the treasure.",
  ].join("\n");
}

const FLAIR = [
  "🚀 Wen moon? Wen gas.",
  "📜 Your tap is on-chain. Your regrets are not.",
  "🦍 Diamond hands, gas-powered.",
  "⛽ Not financial advice. Not even gas advice.",
  "🪙 Congrats, you just paid the network to hear you click.",
  "🐢 Block times are a lifestyle.",
  "⚡ Electroneum: lightning-fast, thumb-powered.",
  "🧠 Brain: 0 gas. Thumb: 1 tap.",
  "🔥 Burning ETN one tap at a time, no s'mores included.",
  "🕳️ Down the gas-fee rabbit hole we go.",
  "🫡 Nonce up, dignity down.",
  "🎰 Every tap is a tiny donation to the gas gods.",
  "🔐 Not your keys, not your ETN. But this tap is all yours.",
  "🧾 Proof of tap, proof of nap-free thumbs.",
];

/** Returns "\n<flair>" for roughly FLAIR_CHANCE of calls, otherwise "". */
export function maybeFlair() {
  return Math.random() < FLAIR_CHANCE ? `\n${FLAIR[Math.floor(Math.random() * FLAIR.length)]}` : "";
}

let context = null;
/** The tap wallet and its RPC provider, created once and shared by every tap bot. */
export function getTapContext() {
  if (!context) {
    const provider = createRpcProvider();
    // Receipt polling every 15s instead of ethers' 4s default; the bots don't need faster confirmations.
    provider.pollingInterval = 15000;
    context = { provider, wallet: new ethers.Wallet(process.env.TAP_WALLET_PRIVATE_KEY, provider) };
  }
  return context;
}

// Taps share one wallet, so sends are serialized to keep nonces from colliding.
let sendQueue = Promise.resolve();
export function enqueue(fn) {
  const run = sendQueue.then(fn);
  sendQueue = run.catch(() => {});
  return run;
}

export function fuelGauge(balanceWei) {
  const eth = Number(ethers.formatEther(balanceWei));
  const filled = Math.max(0, Math.min(10, Math.round((eth / FUEL_FULL_ETN) * 10)));
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${eth.toFixed(2)} ETN`;
}

// Fee data is reused for 30s so each tap doesn't re-query the RPC for it.
const FEE_CACHE_MS = 30 * 1000;
let feeCache = { at: 0, data: null };
async function currentFees(provider) {
  if (!feeCache.data || Date.now() - feeCache.at > FEE_CACHE_MS) {
    feeCache = { at: Date.now(), data: await provider.getFeeData() };
  }
  return feeCache.data;
}

/** Runs inside enqueue(). Returns { hash, tx, balance }, or { hash: null, balance } when the wallet can't cover gas. */
export async function sendTapTx(ctx) {
  const feeData = await currentFees(ctx.provider);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  const balance = await ctx.provider.getBalance(ctx.wallet.address);
  if (balance < TAP_GAS_LIMIT * gasPrice) return { hash: null, balance };

  const tx = await ctx.wallet.sendTransaction({
    to: ctx.wallet.address,
    value: 0n,
    gasLimit: TAP_GAS_LIMIT,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  });
  return { hash: tx.hash, tx, balance };
}

// Keeps the database and the tap reply in step with the chain: the gas figure is only known once
// the receipt lands, so it is written back in the background.
export function trackReceipt(tx) {
  tx.wait()
    .then((receipt) => setTapGas(tx.hash, (receipt.gasUsed * receipt.gasPrice).toString()))
    .catch((err) => console.error("⚠️  Tap receipt tracking failed:", err.message));
}
