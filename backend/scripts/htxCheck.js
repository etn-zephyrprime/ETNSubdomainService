// backend/scripts/htxCheck.js
//
// Checks the HTX API key the ETN bot's cross-exchange trading uses (utils/htxClient.js) BEFORE switching it
// on: the key signs correctly, the spot account's ETN/USDT balances, ETN/USDT's order rules and whether
// ETN and USDT deposits/withdrawals are open. Places NO orders unless --test-order is given, which buys
// ~$1.10 of ETN with an IOC at the best ask and sells it straight back (costs a few cents in fees).
//
// Usage (from backend/, in the Render shell where HTX_API_KEY / HTX_API_SECRET are set):
//   node scripts/htxCheck.js
//   node scripts/htxCheck.js --test-order
import dotenv from "dotenv";
import { htxConfigured, getBalances, getSymbolRules, getAssetStatus, getBook, iocOrder, getWithdrawRules } from "../utils/htxClient.js";

dotenv.config();

async function main() {
  if (!htxConfigured()) throw new Error("HTX_API_KEY / HTX_API_SECRET aren't both set.");
  const bal = await getBalances();
  console.log(`✅ Key works. Spot account: ${bal.ETN.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETN, $${bal.USDT.toFixed(2)} USDT`);
  const rules = await getSymbolRules();
  console.log(`   ETN/USDT rules: trading ${rules.trading ? "ON" : "OFF"}, size step ${rules.sizeStep} ETN, min ${rules.minSize} ETN, price step ${rules.priceStep}, min order $${rules.minFunds}`);
  for (const c of ["ETN", "USDT"]) {
    const s = await getAssetStatus(c);
    console.log(`   ${c}: deposits ${s.deposit ? "open" : "CLOSED"}, withdrawals ${s.withdraw ? "open" : "CLOSED"}`);
  }
  const wr = await getWithdrawRules("ETN", "etn1").catch(() => null);
  if (wr) console.log(`   ETN withdrawals (etn1): ${wr.enabled ? "enabled" : "SUSPENDED"}, fee ${wr.fee} ETN, minimum ${wr.min} ETN — the sweep needs the key's Withdraw permission and the bot wallet in HTX's withdrawal address book`);
  console.log(`   Switches: ETN_BOT_CEX_ARB_LIVE=${process.env.ETN_BOT_CEX_ARB_LIVE || "(unset — off)"}, ETN_BOT_CEX_SWEEP=${process.env.ETN_BOT_CEX_SWEEP || "(unset — off)"}, ETN_BOT_MODE=${process.env.ETN_BOT_MODE || "(unset)"}`);

  if (process.argv.includes("--test-order")) {
    if (bal.USDT < 1.5) throw new Error("Need at least $1.50 USDT in the spot account for the test order.");
    const book = await getBook();
    const ask = Number(book.asks[0][0]);
    const size = Math.ceil(Math.max(rules.minFunds * 1.1, 1.1) / ask);
    const buy = await iocOrder({ side: "buy", size, price: ask, clientOid: `etnbot-check-b-${Date.now()}` });
    console.log(`   Test buy: ${buy.dealSize} ETN for $${buy.dealFunds} (fee ${buy.fee} ${buy.feeCurrency}, ${buy.state})`);
    const have = Math.floor(buy.dealSize - (buy.feeCurrency === "ETN" ? buy.fee : 0));
    if (have > 0) {
      const bid = Number((await getBook()).bids[0][0]);
      const sell = await iocOrder({ side: "sell", size: have, price: bid, clientOid: `etnbot-check-s-${Date.now()}` });
      console.log(`   Test sell: ${sell.dealSize} ETN for $${sell.dealFunds} (fee ${sell.fee} ${sell.feeCurrency}, ${sell.state})`);
    }
    console.log("✅ The key can trade.");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  if (/api-signature-not-valid|invalid-access-key|login-required/i.test(err.message)) console.error("   Check HTX_API_KEY / HTX_API_SECRET, and that the key's IP binding includes this server.");
  process.exitCode = 1;
});
