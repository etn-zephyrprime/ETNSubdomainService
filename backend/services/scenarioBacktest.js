// backend/services/scenarioBacktest.js
//
// Core Tier Scenarios — Tool 5, historical backtest: "what if I'd bought X a year ago?" — as one
// purchase or as equal weekly/monthly buys (DCA). Read-only; nothing is saved.
//
// Data and honesty rules:
//   - Prices are the daily closes in price_points (the PnL Statement's own history). A token's
//     coverage starts at price_history_backfill_state.earliest_available_date; a start date before
//     that is CLAMPED to it, with a message — never extrapolated.
//   - Gap rule (one rule, stated on every result): a day without its own price reuses the last real
//     close (carry-forward). Days stored as "carry-forward" (no trades that day) count the same way.
//     The result says how many days in the window were carried and the longest such stretch.
//   - No historical pool depth exists, so buys assume NO price impact. That flatters thin tokens:
//     the result checks how much selling the position today would move the price and warns.
//   - Transfer tax: tokens with a CORE-style trade tax (utils/tokenTransferTax.js) are bought net of
//     the BUY tax that applied on each buy's own date — read from the token contract at that day's
//     block (an archive read; the chain's 5-second blocks put a date's block at now - days x 17,280).
//   - Survivorship: only tokens with price history today can be tested, and token migrations or
//     contract changes inside the window aren't detected — both stated.
import Decimal from "decimal.js";
import { ethers } from "ethers";
import { getPricePointsRange } from "../db/pricePoints.js";
import { getBackfillState, listBackfilledAssets } from "../db/priceHistoryBackfillState.js";
import { getTokenMetadata } from "./pnlIngestion.js";
import { quoteSell } from "./whatIfSimulator.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { getTradeTax } from "../utils/tokenTransferTax.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

const DAY_MS = 86400000;
const BLOCKS_PER_DAY = 17280;
const MAX_CHART_POINTS = 400;
const MAX_BUYS = 600;
const LOW_LIQUIDITY_IMPACT_PCT = 2;
const ETN_ASSET = "ETN"; // price_points key for native ETN

let provider = null;
const getProvider = () => (provider ||= createRpcProvider());

export class BacktestInputError extends Error {}

const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const iso = (d) => d.toISOString().slice(0, 10);

// ---- Pure maths --------------------------------------------------------------------------------

/** Daily series from `points` ([{ timestamp, price_usd, source }]) over [from, to]:
 * Map(dateIso -> { price, carried }). Days before the first real price are absent. */
export function buildDailySeries(points, from, to) {
  const byDay = new Map();
  for (const p of points) byDay.set(iso(dayStart(new Date(p.timestamp))), p);
  const out = new Map();
  let last = null;
  for (let d = dayStart(from); d <= to; d = new Date(d.getTime() + DAY_MS)) {
    const p = byDay.get(iso(d));
    if (p && Number(p.price_usd) > 0) {
      last = Number(p.price_usd);
      out.set(iso(d), { price: last, carried: p.source === "carry-forward" });
    } else if (last != null) {
      out.set(iso(d), { price: last, carried: true });
    }
  }
  return out;
}

/** Coverage over a series: carried-day count and the longest carried stretch. */
export function coverageOf(series) {
  let carried = 0;
  let run = 0;
  let longest = 0;
  for (const v of series.values()) {
    if (v.carried) {
      carried++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { days: series.size, carriedDays: carried, longestCarried: longest };
}

/** Buy dates: one (lump) or every 7 days / every calendar month from `start` to `end` inclusive. */
export function scheduleBuys(start, end, mode) {
  const s = dayStart(start);
  if (mode === "lump") return [s];
  const out = [];
  if (mode === "weekly") for (let d = s; d <= end && out.length < MAX_BUYS; d = new Date(d.getTime() + 7 * DAY_MS)) out.push(d);
  else if (mode === "monthly") {
    for (let i = 0; out.length < MAX_BUYS; i++) {
      const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + i, Math.min(s.getUTCDate(), 28)));
      if (d > end) break;
      out.push(d);
    }
  } else throw new BacktestInputError("Pick a single buy, weekly or monthly");
  return out;
}

/**
 * The buys themselves. `amountType`: "usd" | "etn" | "tokens" (per buy). Each buy: what it cost in
 * USD and ETN at that day's prices, and the tokens received after that day's buy tax.
 */
export function simulateBuys({ buys, amountType, amount, tokenSeries, etnSeries, taxBpsFor = () => 0, isEtn = false }) {
  return buys.map((d) => {
    const key = iso(d);
    const tp = tokenSeries.get(key)?.price;
    const ep = etnSeries.get(key)?.price;
    if (!tp || !ep) return { date: key, skipped: true };
    const taxBps = isEtn ? 0 : taxBpsFor(key);
    let costUsd;
    let gross;
    if (amountType === "usd") {
      costUsd = amount;
      gross = amount / tp;
    } else if (amountType === "etn") {
      costUsd = amount * ep;
      gross = costUsd / tp;
    } else {
      // A token quantity: what it would have cost to END UP with that many after tax.
      gross = amount / (1 - taxBps / 10000);
      costUsd = gross * tp;
    }
    const tokens = amountType === "tokens" ? amount : gross * (1 - taxBps / 10000);
    return { date: key, priceUsd: tp, etnUsd: ep, costUsd, costEtn: costUsd / ep, tokens, taxBps, taxTokens: gross - tokens };
  });
}

// ---- Live run -------------------------------------------------------------------------------

async function symbolOf(asset) {
  if (asset === ETN_ASSET) return "ETN";
  return (await getTokenMetadata(asset).catch(() => null))?.symbol || `${asset.slice(0, 6)}…`;
}

/** Tokens that can be backtested: every asset with price history, ETN first. */
export async function listBacktestTokens() {
  const assets = await listBackfilledAssets();
  const tokens = await Promise.all(assets.filter((a) => a !== ETN_ASSET).map(async (a) => ({ asset: a, symbol: await symbolOf(a) })));
  return [{ asset: ETN_ASSET, symbol: "ETN" }, ...tokens.filter((t) => !/test/i.test(t.symbol) && !/^TSA/.test(t.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol))];
}

/** The buy tax on `token` on each of `dates` (Map dateIso -> bps), read at that day's block. */
async function historicalBuyTax(token, dates) {
  const tax = await getTradeTax(getProvider(), token);
  if (!tax) return { byDay: new Map(), taxed: false };
  const c = new ethers.Contract(token, ["function currentBuyBps() view returns (uint256)"], getProvider());
  const now = await getProvider().getBlockNumber();
  const byDay = new Map();
  for (const d of dates) {
    const daysAgo = Math.max(0, (Date.now() - new Date(`${d}T12:00:00Z`).getTime()) / DAY_MS);
    const blockTag = Math.max(1, Math.round(now - daysAgo * BLOCKS_PER_DAY));
    const bps = await c.currentBuyBps({ blockTag }).then(Number).catch(() => null);
    byDay.set(d, bps ?? tax.buyBps); // an unreadable day falls back to today's rate (flagged)
  }
  return { byDay, taxed: true, current: tax.buyBps };
}

/**
 * Runs the backtest. Input: { asset ("ETN" | token address), amountType, amount, start, end?, mode }.
 */
export async function runBacktest(input) {
  const asset = String(input.asset || "").toLowerCase() === "etn" ? ETN_ASSET : String(input.asset || "").toLowerCase();
  if (asset !== ETN_ASSET && !ethers.isAddress(asset)) throw new BacktestInputError("Pick a token");
  const amountType = input.amountType;
  if (!["usd", "etn", "tokens"].includes(amountType)) throw new BacktestInputError("Amount must be in USD, ETN or tokens");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new BacktestInputError("Enter an amount greater than zero");
  const mode = input.mode || "lump";
  const today = dayStart(new Date());
  const end = input.end ? dayStart(new Date(input.end)) : today;
  let start = dayStart(new Date(input.start));
  if (!Number.isFinite(start.getTime())) throw new BacktestInputError("Pick a start date");
  if (end > today) throw new BacktestInputError("The end date can't be in the future");
  if (start >= end) throw new BacktestInputError("The start date must be before the end date");
  const isEtn = asset === ETN_ASSET;
  const symbol = await symbolOf(asset);
  const notes = [];

  // Coverage: clamp to the earliest real price, never extrapolate.
  const [tokenState, etnState] = await Promise.all([isEtn ? null : getBackfillState(asset), getBackfillState(ETN_ASSET)]);
  const earliestToken = isEtn ? null : tokenState?.earliest_available_date ? new Date(tokenState.earliest_available_date) : null;
  if (!isEtn && !earliestToken) throw new BacktestInputError(`${symbol} has no price history to test against`);
  const earliest = [earliestToken, etnState?.earliest_available_date ? new Date(etnState.earliest_available_date) : null].filter(Boolean).reduce((a, b) => (a > b ? a : b), new Date(0));
  if (start < earliest) {
    notes.push(`${symbol} price data starts on ${iso(earliest)}, so the start date was moved there from ${iso(start)}.`);
    start = dayStart(earliest);
  }
  if (start >= end) throw new BacktestInputError(`${symbol} price data starts on ${iso(earliest)} — pick a later window`);

  const [tokenPoints, etnPoints] = await Promise.all([isEtn ? null : getPricePointsRange(asset, start, end), getPricePointsRange(ETN_ASSET, start, end)]);
  const etnSeries = buildDailySeries(etnPoints, start, end);
  const tokenSeries = isEtn ? etnSeries : buildDailySeries(tokenPoints, start, end);
  if (tokenSeries.size === 0) throw new BacktestInputError(`No ${symbol} prices in that window`);

  const buyDates = scheduleBuys(start, end, mode);
  const { byDay: taxByDay, taxed, current: currentTax } = isEtn ? { byDay: new Map(), taxed: false } : await historicalBuyTax(asset, buyDates.map(iso));
  const buys = simulateBuys({ buys: buyDates, amountType, amount, tokenSeries, etnSeries, taxBpsFor: (d) => taxByDay.get(d) || 0, isEtn });
  const done = buys.filter((b) => !b.skipped);
  if (done.length === 0) throw new BacktestInputError("None of the buy dates had a price");
  if (done.length < buys.length) notes.push(`${buys.length - done.length} buy date(s) had no price and were skipped.`);

  // End values: live prices for "today", the stored close otherwise.
  const etnCache = await getEtnPriceCache();
  const endIsToday = end.getTime() === today.getTime();
  const endEtnUsd = endIsToday && etnCache?.usd != null ? etnCache.usd : etnSeries.get(iso(end))?.price;
  let endTokenUsd = tokenSeries.get(iso(end))?.price;
  if (endIsToday && endEtnUsd) {
    if (isEtn) endTokenUsd = endEtnUsd;
    else {
      const live = await getTokenEtnPrice(getProvider(), asset).catch(() => null);
      if (live) endTokenUsd = live * endEtnUsd;
    }
  }
  if (!endTokenUsd || !endEtnUsd) throw new BacktestInputError("No price for the end date");

  const sum = (f) => done.reduce((s, b) => s + b[f], 0);
  const tokens = sum("tokens");
  const costUsd = sum("costUsd");
  const costEtn = sum("costEtn");
  const valueUsd = tokens * endTokenUsd;
  const valueEtn = valueUsd / endEtnUsd;
  // Benchmarks: the same USD spent on ETN instead, on the same days; and just keeping the dollars.
  const etnHeld = done.reduce((s, b) => s + b.costUsd / b.etnUsd, 0);
  const etnHoldValueUsd = etnHeld * endEtnUsd;

  // Liquidity realism: no historical depth, so check what selling the position would do today.
  let liquidity = null;
  if (!isEtn) {
    try {
      const { quote } = await quoteSell(asset, new Decimal(tokens));
      const impact = quote.priceImpactPct != null ? Number(quote.priceImpactPct) : null;
      liquidity = { sellImpactPct: impact, lowLiquidity: impact == null || impact > LOW_LIQUIDITY_IMPACT_PCT };
    } catch {
      liquidity = { sellImpactPct: null, lowLiquidity: true };
    }
  }

  // Chart: position value, money put in, and the hold-ETN benchmark, day by day (downsampled).
  const chart = [];
  let held = 0;
  let invested = 0;
  let etnUnits = 0;
  const buyByDay = new Map(done.map((b) => [b.date, b]));
  const days = [...tokenSeries.keys()];
  const step = Math.max(1, Math.ceil(days.length / MAX_CHART_POINTS));
  days.forEach((d, i) => {
    const b = buyByDay.get(d);
    if (b) {
      held += b.tokens;
      invested += b.costUsd;
      etnUnits += b.costUsd / b.etnUsd;
    }
    const ep = etnSeries.get(d)?.price;
    if (i % step === 0 || i === days.length - 1 || b) {
      chart.push({ date: d, valueUsd: held * tokenSeries.get(d).price, investedUsd: invested, etnHoldUsd: ep ? etnUnits * ep : null });
    }
  });

  const cov = coverageOf(tokenSeries);
  const etnCov = coverageOf(etnSeries);
  return {
    asset,
    symbol,
    mode,
    window: { start: iso(start), end: iso(end) },
    buys: done.map((b) => ({ ...b, priceEtn: b.priceUsd / b.etnUsd })),
    totals: {
      tokens,
      costUsd,
      costEtn,
      valueUsd,
      valueEtn,
      returnUsd: valueUsd - costUsd,
      returnPct: costUsd > 0 ? ((valueUsd - costUsd) / costUsd) * 100 : null,
      returnEtn: valueEtn - costEtn,
      returnEtnPct: costEtn > 0 ? ((valueEtn - costEtn) / costEtn) * 100 : null,
      avgCostUsd: tokens > 0 ? costUsd / tokens : null,
      taxTokens: sum("taxTokens"),
    },
    benchmarks: {
      holdEtn: { valueUsd: etnHoldValueUsd, returnPct: costUsd > 0 ? ((etnHoldValueUsd - costUsd) / costUsd) * 100 : null },
      holdUsd: { valueUsd: costUsd, returnPct: 0 },
    },
    endPrices: { tokenUsd: endTokenUsd, etnUsd: endEtnUsd, live: endIsToday },
    coverage: { from: iso(start), earliest: earliestToken ? iso(earliestToken) : iso(earliest), ...cov, etnCarriedDays: etnCov.carriedDays },
    liquidity,
    chart,
    notes,
    assumptions: {
      pricedAt: new Date().toISOString(),
      etnUsd: String(endEtnUsd),
      prices: `Daily closing prices from Argus's price history; ${endIsToday ? "today's value uses live prices" : "the end value uses that day's close"}.`,
      gaps: `Gap rule: a day with no trades or no stored price reuses the last real close. ${cov.carriedDays} of ${cov.days} days in this window were carried (longest run ${cov.longestCarried} days).`,
      impact: "Buys assume no price impact — there's no record of past pool depth — which flatters thin tokens.",
      tax: isEtn ? null : taxed ? `${symbol}'s buy tax is applied at the rate on each buy's own date, read from the token contract (it's ${(currentTax / 100).toFixed(2)}% today).` : `${symbol} has no on-chain trade tax.`,
      benchmark: "\"Hold ETN\" spends the same dollars on ETN on the same days; \"hold USD\" keeps them as cash.",
      survivorship: "Only tokens with price history today can be tested, and token migrations or contract changes inside the window aren't detected.",
      framing: "Past results don't predict future ones. This is a look back, not a recommendation.",
    },
  };
}
