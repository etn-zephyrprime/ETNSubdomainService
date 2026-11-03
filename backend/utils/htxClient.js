// backend/utils/htxClient.js
//
// Minimal signed HTX (formerly Huobi) spot API client for the ETN bot's cross-exchange trading (see
// services/cexVenues.js). Only what that needs: the spot account's balances, ETN/USDT's order rules,
// IOC limit orders, and an order's fill. Credentials come from the environment and never leave the server:
//   HTX_API_KEY, HTX_API_SECRET
// Give the key Read + Trade permission and bind it to the server's IP. Withdraw is only needed for sweeping
// excess ETN back to the bot wallet (ETN_BOT_CEX_SWEEP) — and then only to an address in HTX's address book.
// Signing per HTX's docs: query = AccessKeyId, SignatureMethod=HmacSHA256, SignatureVersion=2,
// Timestamp=YYYY-MM-DDThh:mm:ss (UTC), plus a GET's own params, sorted; the string signed is
// METHOD \n host \n path \n query, and the base64 HMAC-SHA256 goes back as &Signature=.
import crypto from "crypto";

const HOST = process.env.HTX_API_HOST || "api.huobi.pro";
const BASE = `https://${HOST}`;
export const HTX_SYMBOL = "etnusdt";

export function htxConfigured() {
  return Boolean(process.env.HTX_API_KEY && process.env.HTX_API_SECRET);
}

const enc = (v) => encodeURIComponent(String(v));

export function signedQuery(method, path, params, key, secret, now = new Date()) {
  const all = { ...params, AccessKeyId: key, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: now.toISOString().slice(0, 19) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join("&");
  const sig = crypto.createHmac("sha256", secret).update(`${method}\n${HOST}\n${path}\n${query}`).digest("base64");
  return `${query}&Signature=${enc(sig)}`;
}

async function request(method, path, { params = {}, body = null } = {}) {
  if (!htxConfigured()) throw new Error("HTX API credentials not set");
  const url = `${BASE}${path}?${signedQuery(method, path, method === "GET" ? params : {}, process.env.HTX_API_KEY, process.env.HTX_API_SECRET)}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  const ok = json.status === "ok" || json.code === 200;
  if (!res.ok || !ok) throw new Error(`HTX ${method} ${path}: ${json["err-code"] || json.code || res.status} ${json["err-msg"] || json.message || ""}`.trim());
  return json.data;
}

let accountId = null;
async function spotAccountId() {
  if (accountId) return accountId;
  const accounts = await request("GET", "/v1/account/accounts");
  const spot = (accounts || []).find((a) => a.type === "spot" && a.state === "working");
  if (!spot) throw new Error("HTX: no working spot account");
  accountId = spot.id;
  return accountId;
}

/** Available (trade, not frozen) balances in the spot account: { ETN, USDT }. */
export async function getBalances() {
  const data = await request("GET", `/v1/account/accounts/${await spotAccountId()}/balance`);
  const out = { ETN: 0, USDT: 0 };
  for (const r of data?.list || []) {
    const cur = String(r.currency).toUpperCase();
    if (cur in out && r.type === "trade") out[cur] += Number(r.balance);
  }
  return out;
}

/** ETN/USDT's order rules: { sizeStep, minSize, priceStep, minFunds, trading } (public). */
export async function getSymbolRules() {
  const res = await fetch(`${BASE}/v1/settings/common/market-symbols?symbols=${HTX_SYMBOL}`, { signal: AbortSignal.timeout(10000) });
  const json = await res.json().catch(() => ({}));
  const s = (json.data || []).find((x) => x.symbol === HTX_SYMBOL || x.sc === HTX_SYMBOL);
  if (!s) throw new Error("HTX: etnusdt symbol info unavailable");
  return {
    sizeStep: 10 ** -Number(s.tap ?? s["amount-precision"] ?? 0),
    minSize: Number(s.lominoa ?? s["limit-order-min-order-amt"] ?? 0),
    priceStep: 10 ** -Number(s.tpp ?? s["price-precision"] ?? 7),
    minFunds: Number(s.minov ?? s["min-order-value"] ?? 1),
    trading: (s.state || "online") === "online",
  };
}

const fillOf = (o) => ({
  orderId: String(o.id),
  done: ["filled", "partial-canceled", "canceled"].includes(o.state),
  state: o.state,
  dealSize: Number(o["filled-amount"] ?? o["field-amount"] ?? 0),
  dealFunds: Number(o["filled-cash-amount"] ?? o["field-cash-amount"] ?? 0),
  fee: Number(o["filled-fees"] ?? o["field-fees"] ?? 0),
  // HTX takes a buy's fee in the asset bought (ETN) and a sell's in the asset received (USDT).
  feeCurrency: String(o.type || "").startsWith("buy") ? "ETN" : "USDT",
});

/** Places an IOC limit order (anything not filled at once at `price` or better is cancelled) and waits
 * for its final state. side "buy" | "sell"; size in ETN. */
export async function iocOrder({ side, size, price, clientOid }) {
  const orderId = await request("POST", "/v1/order/orders/place", {
    body: { "account-id": String(await spotAccountId()), symbol: HTX_SYMBOL, type: `${side}-ioc`, amount: String(size), price: String(price), "client-order-id": clientOid },
  });
  for (let i = 0; i < 20; i++) {
    const o = await request("GET", `/v1/order/orders/${orderId}`).catch(() => null);
    if (o && fillOf(o).done) return fillOf(o);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`HTX order ${orderId} didn't finish in time`);
}

/** An order's fill by our clientOid, or null if HTX has none. */
export async function getOrderByClientOid(clientOid) {
  try {
    const o = await request("GET", "/v1/order/orders/getClientOrder", { params: { clientOrderId: clientOid } });
    return o ? fillOf(o) : null;
  } catch (err) {
    if (/not-found|base-record-invalid|order-not-exist|record invalid/i.test(err.message)) return null;
    throw err;
  }
}

/** Deposit/withdraw status of a currency on HTX (public): { deposit, withdraw } — true when any chain allows it. */
export async function getAssetStatus(currency) {
  const res = await fetch(`${BASE}/v2/reference/currencies?currency=${currency.toLowerCase()}`, { signal: AbortSignal.timeout(10000) });
  const json = await res.json().catch(() => ({}));
  const chains = json?.data?.[0]?.chains || [];
  return { deposit: chains.some((c) => c.depositStatus === "allowed"), withdraw: chains.some((c) => c.withdrawStatus === "allowed") };
}

/** ETN/USDT's top-20 order book (public): { bids, asks, ts } with [price, size] numbers, best first. */
export async function getBook() {
  const res = await fetch(`${BASE}/market/depth?symbol=${HTX_SYMBOL}&type=step0&depth=20`, { signal: AbortSignal.timeout(5000) });
  const json = await res.json().catch(() => ({}));
  if (json.status !== "ok" || !json.tick) throw new Error("HTX book unavailable");
  // ts = when HTX answered (is this data current?); changedAt = when the book last changed — on a thin
  // market that can be a minute or more, which is fine.
  return { bids: json.tick.bids, asks: json.tick.asks, ts: Number(json.ts || Date.now()), changedAt: Number(json.tick.ts || 0) };
}

/** HTX's withdrawal rules for a currency on a chain (public): { fee, min, enabled }. HTX chain ids differ
 * from the coin name — ETN on the Electroneum chain is "etn1". */
export async function getWithdrawRules(currency, chain) {
  const res = await fetch(`${BASE}/v2/reference/currencies?currency=${currency.toLowerCase()}`, { signal: AbortSignal.timeout(10000) });
  const json = await res.json().catch(() => ({}));
  const c = (json?.data?.[0]?.chains || []).find((x) => x.chain === chain);
  if (!c) throw new Error(`HTX has no ${currency} chain ${chain}`);
  return { fee: Number(c.transactFeeWithdraw ?? c.minTransactFeeWithdraw ?? 0), min: Number(c.minWithdrawAmt || 0), enabled: c.withdrawStatus === "allowed" };
}

/** Withdraws from the spot account to an address (it must be in HTX's withdrawal address book, and the
 * key needs Withdraw permission). Returns HTX's withdrawal id. */
export async function withdraw({ currency, address, amount, chain, fee }) {
  return request("POST", "/v1/dw/withdraw/api/create", { body: { address, currency: currency.toLowerCase(), amount: String(amount), fee: String(fee), chain } });
}

/** This account's actual taker fee on ETN/USDT, in %. */
export async function getTakerFeePct() {
  const rows = await request("GET", "/v2/reference/transact-fee-rate", { params: { symbols: HTX_SYMBOL } });
  const r = (rows || []).find((x) => x.symbol === HTX_SYMBOL);
  if (!r) throw new Error("HTX returned no fee rate for etnusdt");
  // actualTakerRate is after any discount; takerFeeRate the base rate
  return Number(r.actualTakerRate ?? r.takerFeeRate) * 100;
}
