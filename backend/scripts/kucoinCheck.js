// backend/scripts/kucoinCheck.js
//
// Checks the KuCoin API key the ETN bot's live hedging uses (utils/kucoinClient.js) BEFORE switching it
// on: the key signs correctly, the Trading account's ETN/USDT balances, and ETN-USDT's order rules.
// Places NO orders unless --test-order is given, which buys $1 of ETN at market and sells it straight
// back (costs a few cents in fees) to prove the key can trade.
//
// Usage (from backend/, in the Render shell where the KUCOIN_API_* variables are set):
//   node scripts/kucoinCheck.js
//   node scripts/kucoinCheck.js --test-order
import dotenv from "dotenv";
import { kucoinConfigured, getTradeBalances, getSymbolRules, marketOrderAndWait, floorToIncrement } from "../utils/kucoinClient.js";

dotenv.config();

async function main() {
  if (!kucoinConfigured()) throw new Error("KUCOIN_API_KEY / KUCOIN_API_SECRET / KUCOIN_API_PASSPHRASE aren't all set.");
  const bal = await getTradeBalances();
  console.log(`✅ Key works. Trading account: ${bal.ETN.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETN, $${bal.USDT.toFixed(2)} USDT`);
  if (bal.USDT < 1 && bal.ETN < 1) console.log("   (Both are ~0 — move funds into the TRADING account, not Main/Funding, before hedging.)");
  const rules = await getSymbolRules();
  console.log(`   ETN-USDT rules: size step ${rules.baseIncrement} ETN, min ${rules.baseMinSize} ETN, funds step ${rules.quoteIncrement}, min funds ${rules.minFunds || "n/a"}`);
  console.log(`   Live hedging switch: ETN_BOT_HEDGE_LIVE=${process.env.ETN_BOT_HEDGE_LIVE || "(unset — off)"}, ETN_BOT_MODE=${process.env.ETN_BOT_MODE || "(unset)"}`);

  if (process.argv.includes("--test-order")) {
    if (bal.USDT < 1.1) throw new Error("Need at least $1.10 USDT in the Trading account for the test order.");
    const buy = await marketOrderAndWait({ side: "buy", funds: 1, clientOid: `etnbot-check-b-${Date.now()}` });
    console.log(`   Test buy: ${buy.dealSize} ETN for $${buy.dealFunds} (fee ${buy.fee} ${buy.feeCurrency})`);
    const size = floorToIncrement(buy.dealSize, rules.baseIncrement);
    const sell = await marketOrderAndWait({ side: "sell", size, clientOid: `etnbot-check-s-${Date.now()}` });
    console.log(`   Test sell: ${sell.dealSize} ETN for $${sell.dealFunds} (fee ${sell.fee} ${sell.feeCurrency})`);
    console.log("✅ The key can trade.");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  if (/400005|400004|400003|Invalid KC-API/i.test(err.message)) console.error("   Check the key, secret and passphrase, and KUCOIN_API_KEY_VERSION (try 3 if KuCoin shows a v3 key).");
  if (/400006|IP/i.test(err.message)) console.error("   The key's IP restriction doesn't include this server's outbound IP.");
  process.exitCode = 1;
});
