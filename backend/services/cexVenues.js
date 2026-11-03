// backend/services/cexVenues.js
//
// The centralised exchanges the ETN bot can trade ETN/USDT on, behind one shape so the hedge and the
// CEX-vs-CEX arbitrage don't care which is which:
//   name, feePct            taker fee %
//   configured()            the venue's API key is set (trading possible)
//   book()                  { bids, asks, ts } — public, numbers, best first
//   balances()              { ETN, USDT } available to trade
//   rules()                 { sizeStep, minSize, priceStep, minFunds }
//   status()                { trading, etn: {deposit, withdraw}, usdt: {deposit, withdraw} } — public
//   ioc(order)              IOC limit order { side, size, price, clientOid } -> fill (waits for it)
//   byClientOid(clientOid)  a fill already placed under that id, or null
import * as kucoin from "../utils/kucoinClient.js";
import * as htx from "../utils/htxClient.js";

const num = (name, dflt) => (process.env[name] != null && process.env[name] !== "" ? Number(process.env[name]) : dflt);

const cache = new Map(); // key -> { at, value } — status/rules change rarely; don't ask every check
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const VENUES = {
  kucoin: {
    name: "KuCoin",
    // Starts at the configured rate; refreshFees() replaces it with the account's real one (never lower).
    feePct: num("ETN_BOT_KUCOIN_FEE_PCT", num("ETN_BOT_HEDGE_KUCOIN_FEE_PCT", 0.1)),
    configuredFeePct: num("ETN_BOT_KUCOIN_FEE_PCT", num("ETN_BOT_HEDGE_KUCOIN_FEE_PCT", 0.1)),
    readFeePct: kucoin.getTakerFeePct,
    configured: kucoin.kucoinConfigured,
    book: kucoin.getBook,
    balances: kucoin.getTradeBalances,
    rules: () =>
      cached("kucoin:rules", 3600000, async () => {
        const r = await kucoin.getSymbolRules();
        return { sizeStep: r.baseIncrement, minSize: r.baseMinSize, priceStep: r.priceIncrement, minFunds: r.minFunds };
      }),
    status: () =>
      cached("kucoin:status", 300000, async () => ({
        trading: await kucoin.getTradingEnabled(),
        etn: await kucoin.getAssetStatus("ETN", "etnevm"),
        usdt: await kucoin.getAssetStatus("USDT"),
      })),
    ioc: kucoin.iocOrder,
    byClientOid: kucoin.getOrderByClientOid,
  },
  htx: {
    name: "HTX",
    feePct: num("ETN_BOT_HTX_FEE_PCT", 0.2),
    configuredFeePct: num("ETN_BOT_HTX_FEE_PCT", 0.2),
    readFeePct: htx.getTakerFeePct,
    configured: htx.htxConfigured,
    book: htx.getBook,
    balances: htx.getBalances,
    rules: () => cached("htx:rules", 3600000, htx.getSymbolRules),
    status: () =>
      cached("htx:status", 300000, async () => ({
        trading: (await htx.getSymbolRules()).trading,
        etn: await htx.getAssetStatus("ETN"),
        usdt: await htx.getAssetStatus("USDT"),
      })),
    ioc: htx.iocOrder,
    byClientOid: htx.getOrderByClientOid,
  },
};

/** Books from every venue that answers (a venue whose book can't be read is just left out this check). */
export async function allBooks() {
  const out = {};
  await Promise.all(
    Object.entries(VENUES).map(async ([k, v]) => {
      try {
        out[k] = await v.book();
      } catch {
        // unavailable this check
      }
    })
  );
  return out;
}

export const feesOf = () => Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, v.feePct]));

let feesReadAt = 0;
/** Reads each configured venue's real taker fee (hourly) and uses the HIGHER of it and the configured
 * rate — every break-even price depends on this, so an understated fee could make a "can't lose" leg
 * lose. A venue whose fee can't be read keeps the configured rate. Returns { venue: feePct }. */
export async function refreshFees(force = false) {
  if (!force && Date.now() - feesReadAt < 3600000) return feesOf();
  feesReadAt = Date.now();
  for (const v of Object.values(VENUES)) {
    if (!v.configured()) continue;
    const real = await v.readFeePct().catch(() => null);
    if (Number.isFinite(real) && real > 0) v.feePct = Math.max(real, v.configuredFeePct);
  }
  return feesOf();
}
