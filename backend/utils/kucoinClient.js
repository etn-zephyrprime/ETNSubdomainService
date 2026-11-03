// backend/utils/kucoinClient.js
//
// Minimal signed KuCoin spot API client for the ETN bot's hedged catch-up (services/etnHedgeStrategy.js).
// Only what that needs: trading-account balances, the ETN-USDT symbol's size rules, market orders, and
// an order's fill. Credentials come from the environment and never leave the server:
//   KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE
//   KUCOIN_API_KEY_VERSION (optional, default "2" — set "3" if KuCoin's API page shows a v3 key)
// The key should have General + Spot Trading permission ONLY — no withdrawals — so even a leaked key
// can't move funds off KuCoin. Requests are signed per KuCoin's docs: base64(HMAC-SHA256(secret,
// timestamp + METHOD + path + body)), passphrase HMAC'd with the secret for v2+ keys.
import crypto from "crypto";

const BASE = "https://api.kucoin.com";
export const KUCOIN_SYMBOL = "ETN-USDT";

export function kucoinConfigured() {
  return Boolean(process.env.KUCOIN_API_KEY && process.env.KUCOIN_API_SECRET && process.env.KUCOIN_API_PASSPHRASE);
}

const sign = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("base64");

async function request(method, path, body = null) {
  if (!kucoinConfigured()) throw new Error("KuCoin API credentials not set");
  const ts = String(Date.now());
  const bodyText = body ? JSON.stringify(body) : "";
  const secret = process.env.KUCOIN_API_SECRET;
  const version = process.env.KUCOIN_API_KEY_VERSION || "2";
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "KC-API-KEY": process.env.KUCOIN_API_KEY,
      "KC-API-SIGN": sign(secret, ts + method + path + bodyText),
      "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": version === "1" ? process.env.KUCOIN_API_PASSPHRASE : sign(secret, process.env.KUCOIN_API_PASSPHRASE),
      "KC-API-KEY-VERSION": version,
    },
    body: bodyText || undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== "200000") throw new Error(`KuCoin ${method} ${path.split("?")[0]}: ${json.code || res.status} ${json.msg || ""}`.trim());
  return json.data;
}

/** Available balances in the Trading account: { USDT, ETN } (numbers). */
export async function getTradeBalances() {
  const rows = await request("GET", "/api/v1/accounts?type=trade");
  const out = { USDT: 0, ETN: 0 };
  for (const r of rows || []) if (r.currency in out) out[r.currency] += Number(r.available);
  return out;
}

/** A symbol's order rules (default ETN-USDT): { baseIncrement, baseMinSize, quoteIncrement, minFunds } (numbers). */
export async function getSymbolRules(symbol = KUCOIN_SYMBOL) {
  const r = await request("GET", `/api/v2/symbols/${symbol}`);
  return { baseIncrement: Number(r.baseIncrement), baseMinSize: Number(r.baseMinSize), quoteIncrement: Number(r.quoteIncrement), minFunds: Number(r.minFunds || 0) };
}

/** Rounds a quantity DOWN to an increment (KuCoin rejects sizes off its increment). */
export function floorToIncrement(x, inc) {
  if (!(inc > 0)) return x;
  const decimals = Math.max(0, Math.round(-Math.log10(inc)));
  return Number((Math.floor(x / inc + 1e-9) * inc).toFixed(decimals));
}

/** Places a market order. Buy: `funds` USDT to spend. Sell: `size` ETN. Returns the orderId. */
export async function placeMarketOrder({ side, funds = null, size = null, clientOid }) {
  const body = { clientOid, side, symbol: KUCOIN_SYMBOL, type: "market", ...(funds != null ? { funds: String(funds) } : { size: String(size) }) };
  return (await request("POST", "/api/v1/orders", body)).orderId;
}

/** An order's fill: { done, dealSize (ETN), dealFunds (USDT), fee (USDT) }. */
export async function getOrder(orderId) {
  const o = await request("GET", `/api/v1/orders/${orderId}`);
  return { done: !o.isActive, dealSize: Number(o.dealSize), dealFunds: Number(o.dealFunds), fee: Number(o.fee), feeCurrency: o.feeCurrency };
}

/** Places a market order and waits (up to ~10s) for it to finish; returns the fill. */
export async function marketOrderAndWait(params) {
  const orderId = await placeMarketOrder(params);
  for (let i = 0; i < 20; i++) {
    const o = await getOrder(orderId).catch(() => null);
    if (o?.done) return { orderId, ...o };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`KuCoin order ${orderId} didn't finish in time`);
}

/** An order's fill by our own clientOid (so a retried hedge leg finds an order that already went
 * through), or null if KuCoin has no such order. */
export async function getOrderByClientOid(clientOid) {
  try {
    const o = await request("GET", `/api/v1/order/client-order/${encodeURIComponent(clientOid)}`);
    if (!o) return null;
    return { orderId: o.id, done: !o.isActive, dealSize: Number(o.dealSize), dealFunds: Number(o.dealFunds), fee: Number(o.fee), feeCurrency: o.feeCurrency };
  } catch (err) {
    if (/400100|404|not exist/i.test(err.message)) return null;
    throw err;
  }
}

// ---- round trip (rebalancing between KuCoin and the bot wallet) -------------------------------------
// Deposits land in KuCoin's MAIN (funding) account and withdrawals leave from it; trading uses the
// TRADE account — so funds are moved between the two with inner transfers. These calls need the key's
// Withdrawal permission (and, for withdrawals, the destination on KuCoin's withdrawal whitelist if that's
// switched on). The bot only ever withdraws to its own wallet.

/** Available balances in an account type ("main" or "trade"): { USDT, USDC, ETN }. */
export async function getBalances(type) {
  const rows = await request("GET", `/api/v1/accounts?type=${type}`);
  const out = { USDT: 0, USDC: 0, ETN: 0 };
  for (const r of rows || []) if (r.currency in out) out[r.currency] += Number(r.available);
  return out;
}

/** The account's deposit address for a currency on a chain (KuCoin chain ids: "base", "eth", "etnevm"), or
 * null if none has been created yet (create one in KuCoin's Deposit page first). */
export async function getDepositAddress(currency, chain) {
  const v3 = await request("GET", `/api/v3/deposit-addresses?currency=${currency}&chain=${chain}`).catch(() => null);
  const row = Array.isArray(v3) ? v3.find((r) => !chain || String(r.chainId || r.chain || "").toLowerCase() === chain) || v3[0] : null;
  if (row?.address) return { address: row.address, memo: row.memo || null };
  const v1 = await request("GET", `/api/v1/deposit-addresses?currency=${currency}&chain=${chain}`).catch(() => null);
  return v1?.address ? { address: v1.address, memo: v1.memo || null } : null;
}

/** Moves `amount` of a currency between KuCoin accounts ("main" <-> "trade"). */
export async function innerTransfer({ currency, from, to, amount, clientOid }) {
  return request("POST", "/api/v2/accounts/inner-transfer", { clientOid, currency, from, to, amount: String(amount) });
}

/** Withdraws from the MAIN account to an external address on a chain. Returns KuCoin's withdrawal id. */
export async function withdraw({ currency, address, amount, chain }) {
  const v3 = await request("POST", "/api/v3/withdrawals", { currency, toAddress: address, amount: String(amount), withdrawType: "ADDRESS", chain, isInner: false }).catch((err) => err);
  if (!(v3 instanceof Error)) return v3?.withdrawalId || v3;
  if (!/404|not found|400100/i.test(v3.message)) throw v3;
  return (await request("POST", "/api/v1/withdrawals", { currency, address, amount: String(amount), chain, isInner: false })).withdrawalId;
}

/** A currency's withdrawal fee and minimum on a chain, from KuCoin's public currency info. */
export async function getWithdrawRules(currency, chain) {
  const res = await fetch(`${BASE}/api/v3/currencies/${currency}`, { signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  const c = (json?.data?.chains || []).find((x) => String(x.chainId).toLowerCase() === chain);
  if (!c) throw new Error(`KuCoin has no ${currency} chain ${chain}`);
  return { fee: Number(c.withdrawalMinFee), min: Number(c.withdrawalMinSize), enabled: Boolean(c.isWithdrawEnabled), depositEnabled: Boolean(c.isDepositEnabled) };
}

/** Market-sells `size` of a base currency on any symbol (used for USDC-USDT, turning bridged USDC into USDT). */
export async function marketSellOn(symbol, size, clientOid) {
  const orderId = (await request("POST", "/api/v1/orders", { clientOid, side: "sell", symbol, type: "market", size: String(size) })).orderId;
  for (let i = 0; i < 20; i++) {
    const o = await request("GET", `/api/v1/orders/${orderId}`).catch(() => null);
    if (o && !o.isActive) return { orderId, dealSize: Number(o.dealSize), dealFunds: Number(o.dealFunds), fee: Number(o.fee), feeCurrency: o.feeCurrency };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`KuCoin order ${orderId} didn't finish in time`);
}
