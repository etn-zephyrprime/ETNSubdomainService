import "dotenv/config";
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getBalances as getKucoinBalances, kucoinConfigured } from "../utils/kucoinClient.js";
import { getBalances as getHtxBalances, htxConfigured } from "../utils/htxClient.js";
import { getBotState, botStateConfigured } from "../state/etnAccumulatorBotState.js";

const TOKENS = {
  WETN: { address: "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77", decimals: 18 },
  USDT: { address: "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7", decimals: 6 },
  USDC: { address: "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e", decimals: 6 },
};
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

function amount(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

async function readWallet(provider) {
  const key = process.env.ETN_BOT_PRIVATE_KEY || process.env.BACKEND_PRIVATE_KEY;
  const address = process.env.ETN_BOT_WALLET_ADDRESS || (key ? new ethers.Wallet(key).address : null);
  if (!address) throw new Error("Set ETN_BOT_WALLET_ADDRESS or ETN_BOT_PRIVATE_KEY/BACKEND_PRIVATE_KEY");

  const native = Number(ethers.formatEther(await provider.getBalance(address)));
  const tokens = {};
  for (const [symbol, token] of Object.entries(TOKENS)) {
    const raw = await new ethers.Contract(token.address, ERC20_ABI, provider).balanceOf(address);
    tokens[symbol] = Number(ethers.formatUnits(raw, token.decimals));
  }
  return { address, nativeETN: native, tokens };
}

async function readExchange(name, configured, read) {
  if (!configured()) return { configured: false };
  try {
    return { configured: true, balances: await read() };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

async function readLedger() {
  if (!botStateConfigured()) return { configured: false };
  try {
    const state = await getBotState("live");
    if (!state) return { configured: true, stateExists: false };
    return {
      configured: true,
      stateExists: true,
      updatedAt: state.updatedAt || null,
      hedgeLive: state.hedgeLive
        ? {
            walletEtnNet: state.hedgeLive.walletEtnNet || 0,
            kucoinEtnNet: state.hedgeLive.kucoinEtnNet || 0,
            stables: state.hedgeLive.stables || { USDT: 0, USDC: 0 },
            pausedReason: state.hedgeLive.pausedReason || null,
            unfinishedLeg: Boolean(state.hedgeLeg),
          }
        : null,
      cexArb: state.cexArb
        ? {
            paused: state.cexArb.paused || null,
            today: state.cexArb.today || null,
            unfinishedLeg: Boolean(state.arbLeg),
          }
        : null,
      gapBook: state.gap
        ? { stables: state.gap.stables || null }
        : null,
      catchupBook: state.cu
        ? { cash: state.cu.cash || null }
        : null,
    };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function printBalances(label, result) {
  console.log(`\n${label}`);
  if (!result.configured) {
    console.log("  Not configured");
    return;
  }
  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
    return;
  }
  for (const [symbol, value] of Object.entries(result.balances || {})) console.log(`  ${symbol}: ${amount(value)}`);
}

const provider = createRpcProvider();
const [block, wallet, kucoinMain, kucoinTrade, htx, ledger] = await Promise.all([
  provider.getBlockNumber(),
  readWallet(provider),
  readExchange("KuCoin main", kucoinConfigured, () => getKucoinBalances("main")),
  readExchange("KuCoin trade", kucoinConfigured, () => getKucoinBalances("trade")),
  readExchange("HTX trade", htxConfigured, getHtxBalances),
  readLedger(),
]);

console.log(`ETN bot balance check — ${new Date().toISOString()} — block ${block}`);
console.log(`\nWallet ${wallet.address}`);
console.log(`  Native ETN: ${amount(wallet.nativeETN)}`);
for (const [symbol, value] of Object.entries(wallet.tokens)) console.log(`  ${symbol}: ${amount(value)}`);
printBalances("KuCoin main account", kucoinMain);
printBalances("KuCoin trading account", kucoinTrade);
printBalances("HTX trading account", htx);

console.log("\nLive ledger allocation");
if (!ledger.configured) console.log("  R2 not configured");
else if (ledger.error) console.log(`  ERROR: ${ledger.error}`);
else if (!ledger.stateExists) console.log("  No live ledger has been created");
else console.log(JSON.stringify(ledger, null, 2));

if (ledger?.hedgeLive && wallet) {
  console.log("\nHedge affordability snapshot");
  const sharedUsdc = (ledger.gapBook?.stables?.USDC || 0) + (ledger.hedgeLive.stables.USDC || 0);
  const sharedUsdt = (ledger.gapBook?.stables?.USDT || 0) + (ledger.hedgeLive.stables.USDT || 0);
  console.log(`  Wallet USDC: ${amount(wallet.tokens.USDC)}; shared gap/hedge USDC: ${amount(sharedUsdc)}`);
  console.log(`  Wallet USDT: ${amount(wallet.tokens.USDT)}; shared gap/hedge USDT: ${amount(sharedUsdt)}`);
  console.log(`  KuCoin trade ETN: ${amount(kucoinTrade?.balances?.ETN || 0)}`);
  console.log("  Gap and hedge trades share these book balances; catch-up cash and open positions remain reserved.");
}
