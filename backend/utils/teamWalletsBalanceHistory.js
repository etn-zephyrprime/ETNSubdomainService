import { TEAM_WALLET_ADDRESSES } from "./teamWalletsCache.js";
import { getTeamWalletsBalanceHistoryCache, setTeamWalletsBalanceHistoryCache } from "../state/teamWalletsBalanceHistoryState.js";

// Backfills and maintains a daily "combined ETN balance across every known Electroneum team
// wallet, over the last BACKFILL_DAYS" series — powers the chart on Argus's Team Wallets tab.
//
// Blockscout's own day-bucketed endpoint (/addresses/{address}/coin-balance-history-by-day) only
// covers the last 90 days on this deployment (confirmed live: its own response carries a fixed
// "days": 90, regardless of a requested `days` query param) — nowhere near the 12 months asked
// for. Its EVENT-level counterpart, /addresses/{address}/coin-balance-history, has no such cap:
// it's the real, paginated ledger of every native-balance-changing event for that address, each
// entry carrying the address's ACTUAL post-event balance (not a delta to reconstruct/estimate
// from) — walking it back far enough gives real historical balances, not an approximation. This
// file does that walk once per refresh (not a gradual multi-cycle backfill like
// dailyBlockStatsCache.js — confirmed live the total volume across all team wallets is small
// enough, ~1,100 transactions combined as of writing, max ~13 pages for the busiest single
// wallet, to just re-walk fully every cycle rather than building incremental-resume/cursor logic).
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const CACHE_INTERVAL_MS = process.env.TEAM_WALLETS_BALANCE_HISTORY_INTERVAL_MS
  ? parseInt(process.env.TEAM_WALLETS_BALANCE_HISTORY_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000; // daily — a day-granularity history chart doesn't need to be fresher than this
const BACKFILL_DAYS = process.env.TEAM_WALLETS_BALANCE_HISTORY_DAYS
  ? parseInt(process.env.TEAM_WALLETS_BALANCE_HISTORY_DAYS, 10)
  : 365;
// Safety net against a runaway wallet (or an API change breaking pagination termination) — real
// usage as of writing needs at most ~13 pages for the busiest team wallet, so this is a generous
// margin, not a real limit.
const MAX_PAGES_PER_WALLET = 100;

function dateKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // "2026-09-15T21:09:09Z" -> "2026-09-15"
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(path) {
  const res = await fetch(`${EXPLORER_BASE_URL}/api/v2${path}`);
  if (!res.ok) throw new Error(`Blockscout ${path} returned ${res.status}`);
  return res.json();
}

// Walks one wallet's full coin-balance-history backward (newest-first, Blockscout's own order)
// until either its genesis (no next_page_params — the wallet's real first-ever balance change) or
// a page whose OLDEST item already falls before `cutoffDate`, whichever comes first — since pages
// only get older from there, it's safe to stop the moment any item on a page crosses the cutoff.
// Returns a Map<date, balanceWei> holding one entry per date the balance actually changed (the
// LATEST entry for that date, i.e. its real end-of-day balance) — sparse by design; the caller
// forward-fills the gaps, since "no entry that day" means "balance unchanged from the day before",
// not zero.
export async function fetchWalletBalanceEvents(address, cutoffDate) {
  const perDate = new Map();
  let params = null;

  for (let page = 0; page < MAX_PAGES_PER_WALLET; page++) {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetchJson(`/addresses/${address}/coin-balance-history${query}`);
    const items = res.items || [];
    if (items.length === 0) break;

    let sawOlderThanCutoff = false;
    for (const item of items) {
      const date = dateKey(item.block_timestamp);
      // Items arrive newest-first, so the FIRST one seen for a given date is that date's real
      // closing balance — never overwrite once set.
      if (!perDate.has(date)) perDate.set(date, item.value);
      if (date < cutoffDate) sawOlderThanCutoff = true;
    }

    if (sawOlderThanCutoff || !res.next_page_params) break;
    params = res.next_page_params;
  }

  return perDate;
}

// Forward-fills a sparse per-date balance map into one entry per day across [startDate, endDate]
// inclusive — a day with no balance-changing event keeps the most recent known balance, not 0.
//
// The balance a wallet ALREADY HAD when the window opens matters as much as the events inside it:
// fetchWalletBalanceEvents stops at the first page containing an entry older than the cutoff, so
// `perDate` also holds the wallet's most recent pre-window entries — and the newest of those is its
// real opening balance. Starting from 0 instead (as this once did) made every wallet that simply held
// ETN through the cutoff "appear" on its first in-window event, so the chart's first day understated
// the total by hundreds of millions of ETN and then jumped up as each wallet showed up. A wallet with
// no entry at all on or before the start genuinely had 0 (fetchWalletBalanceEvents walked back to its
// genesis or past the cutoff).
export function forwardFill(perDate, startDate, endDate) {
  const filled = new Map();

  let current = 0n;
  let openingDate = null;
  for (const date of perDate.keys()) {
    if (date <= startDate && (openingDate === null || date > openingDate)) openingDate = date;
  }
  if (openingDate !== null) current = BigInt(perDate.get(openingDate));

  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (perDate.has(d)) current = BigInt(perDate.get(d));
    filled.set(d, current);
  }

  return filled;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cutoffDate = addDays(today, -BACKFILL_DAYS);

    const perWalletFilled = await Promise.all(
      TEAM_WALLET_ADDRESSES.map(async (address) => {
        try {
          const events = await fetchWalletBalanceEvents(address, cutoffDate);
          return forwardFill(events, cutoffDate, today);
        } catch (err) {
          console.warn(`⚠️  Team wallets balance history: failed to fetch ${address}:`, err.message);
          return null;
        }
      })
    );

    const succeeded = perWalletFilled.filter(Boolean);
    if (succeeded.length === 0) {
      console.warn("⚠️  Team wallets balance history: every wallet fetch failed this cycle — keeping previous published series");
      return;
    }

    const series = [];
    for (let d = cutoffDate; d <= today; d = addDays(d, 1)) {
      const total = succeeded.reduce((sum, walletMap) => sum + (walletMap.get(d) ?? 0n), 0n);
      series.push({ date: d, totalBalance: total.toString() });
    }

    // Per-wallet daily balances (whole ETN, aligned to `series` by index) so the chart can be filtered to one
    // wallet. Whole ETN rather than wei keeps the file small; a wallet whose fetch failed is left out.
    const dates = series.map((p) => p.date);
    const wallets = {};
    TEAM_WALLET_ADDRESSES.forEach((address, i) => {
      const walletMap = perWalletFilled[i];
      if (!walletMap) return;
      wallets[address.toLowerCase()] = dates.map((d) => Number((walletMap.get(d) ?? 0n) / 10n ** 18n));
    });

    await setTeamWalletsBalanceHistoryCache(series, wallets);
    console.log(`📈 Team wallets balance history updated — ${series.length} day(s), ${succeeded.length}/${TEAM_WALLET_ADDRESSES.length} wallet(s)`);
  } catch (err) {
    console.error("⚠️  Team wallets balance history refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background backfill/refresh. No-op if R2 isn't configured — nowhere public to
 * publish to, same as every other R2-backed cache in this backend.
 */
export function startTeamWalletsBalanceHistory() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — team wallets balance history disabled");
    return;
  }

  console.log(`📈 Team wallets balance history started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, ${BACKFILL_DAYS}-day window)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
