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

/** ETN-USDT's order rules: { baseIncrement, baseMinSize, quoteIncrement, minFunds } (numbers). */
export async function getSymbolRules() {
  const r = await request("GET", `/api/v2/symbols/${KUCOIN_SYMBOL}`);
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
