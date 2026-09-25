import { listCexAddresses } from "../db/cexAddresses.js";
import { getCexBalanceHistoryCache, setCexBalanceHistoryCache } from "../state/cexBalanceHistoryState.js";

// Backfills and maintains a daily "combined ETN balance across every known CEX/bridge address, over
// the last BACKFILL_DAYS" series, plus each address's own current balance — powers the free
// dashboard's CEX Balances tab. Near-identical to teamWalletsBalanceHistory.js (same Blockscout
// event-ledger walk, same forward-fill reasoning — see that file's own header comment for why the
// day-bucketed endpoint isn't used and why a wallet's PRE-window balance matters for the chart's
// first day), with one real difference: cex_addresses (see db/cexAddresses.js) is a manually-
// maintained, GROWING list — addresses get added via scripts/addCexAddress.js at any time, unlike
// TEAM_WALLET_ADDRESSES' static array — so this re-reads the list from Postgres at the start of
// every cycle instead of importing a fixed array once. A newly-added address's history only reaches
// back to BACKFILL_DAYS same as everyone else, computed fresh the first cycle after it's added —
// nothing needs telling this file about it.
//
// Despite the table's own name, cex_addresses also holds non-exchange "known counterparty" addresses
// (see db/cexAddresses.js's own header comment, e.g. a bridge contract) — this chart shows the whole
// list as-is, honestly labeled with whatever `label` each row was given, same as
// backend/utils/cexAddressesRouter.js's own admin listing does.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const CACHE_INTERVAL_MS = process.env.CEX_BALANCE_HISTORY_INTERVAL_MS
  ? parseInt(process.env.CEX_BALANCE_HISTORY_INTERVAL_MS, 10)
  : 24 * 60 * 60 * 1000; // daily — a day-granularity history chart doesn't need to be fresher than this
const BACKFILL_DAYS = process.env.CEX_BALANCE_HISTORY_DAYS
  ? parseInt(process.env.CEX_BALANCE_HISTORY_DAYS, 10)
  : 365;
// Safety net against a runaway address (or an API change breaking pagination termination) — same
// generous-margin reasoning as teamWalletsBalanceHistory.js's own identical constant.
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

// Identical walk to teamWalletsBalanceHistory.js's own fetchWalletBalanceEvents — see that file's
// own comment for the full reasoning (real per-event balances, not day-bucketed/estimated; stops
// the moment any item on a page crosses the cutoff since pages only get older from there).
export async function fetchAddressBalanceEvents(address, cutoffDate) {
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
      if (!perDate.has(date)) perDate.set(date, item.value);
      if (date < cutoffDate) sawOlderThanCutoff = true;
    }

    if (sawOlderThanCutoff || !res.next_page_params) break;
    params = res.next_page_params;
  }

  return perDate;
}

// Identical to teamWalletsBalanceHistory.js's own forwardFill — see that file's own comment for why
// the pre-window opening balance matters (a wallet's chart shouldn't "appear" from 0 on its first
// in-window event when it already held a real balance before the window opened).
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

// Exported so scripts/runCexBalanceHistory.js can trigger a real refresh on demand (e.g. right
// after adding a new address via addCexAddress.js) instead of waiting up to CACHE_INTERVAL_MS for
// the next scheduled cycle, or a redeploy for the immediate startup run.
export async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const cexAddresses = await listCexAddresses();
    if (cexAddresses.length === 0) {
      console.log("ℹ️  CEX balance history: no addresses recorded in cex_addresses yet — nothing to publish");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const cutoffDate = addDays(today, -BACKFILL_DAYS);

    const perAddressFilled = await Promise.all(
      cexAddresses.map(async (row) => {
        try {
          const events = await fetchAddressBalanceEvents(row.address, cutoffDate);
          return { row, filled: forwardFill(events, cutoffDate, today) };
        } catch (err) {
          console.warn(`⚠️  CEX balance history: failed to fetch ${row.address} (${row.label}):`, err.message);
          return null;
        }
      })
    );

    const succeeded = perAddressFilled.filter(Boolean);
    if (succeeded.length === 0) {
      console.warn("⚠️  CEX balance history: every address fetch failed this cycle — keeping previous published series");
      return;
    }

    const dateRange = [];
    for (let d = cutoffDate; d <= today; d = addDays(d, 1)) dateRange.push(d);

    const series = dateRange.map((d) => ({
      date: d,
      totalBalance: succeeded.reduce((sum, { filled }) => sum + (filled.get(d) ?? 0n), 0n).toString(),
    }));

    // Current (today's) balance per address, PLUS that same address's own daily series over the
    // whole window — powers CexBalanceLineChart.jsx's per-CEX toggleable lines, so a member can
    // isolate/compare individual exchanges instead of only ever seeing the combined total. The same
    // forward-filled map already has both, no separate fetch needed.
    const addresses = succeeded.map(({ row, filled }) => ({
      address: row.address,
      label: row.label,
      balance: (filled.get(today) ?? 0n).toString(),
      series: dateRange.map((d) => ({ date: d, balance: (filled.get(d) ?? 0n).toString() })),
    }));

    await setCexBalanceHistoryCache(series, addresses);
    console.log(`📈 CEX balance history updated — ${series.length} day(s), ${succeeded.length}/${cexAddresses.length} address(es)`);
  } catch (err) {
    console.error("⚠️  CEX balance history refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background backfill/refresh. No-op if R2 isn't configured — nowhere public to publish
 * to, same as every other R2-backed cache in this backend.
 */
export function startCexBalanceHistory() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — CEX balance history disabled");
    return;
  }

  console.log(`📈 CEX balance history started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, ${BACKFILL_DAYS}-day window)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
