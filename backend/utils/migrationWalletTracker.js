import { getMigrationWalletCache, setMigrationWalletCache } from "../state/migrationWalletState.js";

// Dedicated watch on ONE specific wallet — 0xC25CfD4901aA9b43ab81A57b423fd5D17ace9545, flagged live
// after a ~2.19 BILLION ETN balance appeared on it in a single event (confirmed via Blockscout: its
// own coin-balance-history has exactly one entry, `transaction_hash: null`, block 16034825,
// 2026-09-24T20:34:07Z — a balance-level credit outside normal transaction accounting, consistent
// with a chain-level migration credit rather than an ordinary transfer; this wallet had ZERO regular
// transactions before or since). Powers the ETN Bridge tab's own dedicated section for it — same
// event-walk + forward-fill technique as teamWalletsBalanceHistory.js/cexBalanceHistory.js (its
// closest siblings), just scoped to a single hardcoded address instead of a list, plus this
// wallet's own recent transaction activity (currently none — the whole point of watching is to
// notice the FIRST time that changes).
//
// Deliberately its own file rather than folded into cexBalanceHistory.js/teamWalletsBalanceHistory.js
// — this is a single, specific address of interest, not a member of either of those maintained
// lists (it isn't a confirmed team wallet or a known exchange), and giving it its own tracker means
// it can poll far more often than either (see POLL_INTERVAL_MS below) without changing either of
// those files' own daily cadence.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
export const MIGRATION_WALLET_ADDRESS = "0xC25CfD4901aA9b43ab81A57b423fd5D17ace9545";
// Far more frequent than the CEX/team-wallet balance-history caches (daily) — the entire point of
// this tracker is noticing quickly if this specific, unusually large balance ever starts moving,
// not just eventually reflecting it in a once-a-day chart.
const POLL_INTERVAL_MS = process.env.MIGRATION_WALLET_INTERVAL_MS
  ? parseInt(process.env.MIGRATION_WALLET_INTERVAL_MS, 10)
  : 15 * 60 * 1000; // 15 minutes
const BACKFILL_DAYS = process.env.MIGRATION_WALLET_HISTORY_DAYS
  ? parseInt(process.env.MIGRATION_WALLET_HISTORY_DAYS, 10)
  : 365;
const MAX_PAGES = 100;
const MAX_TRANSACTIONS_SHOWN = 25;

function dateKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10);
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

// Same walk as cexBalanceHistory.js's own fetchAddressBalanceEvents — see that file's own comment
// for the full reasoning (real per-event balances from Blockscout's own ledger, not day-bucketed/
// estimated). Also returns the single event with the LARGEST positive delta seen across the whole
// walk — for a wallet whose balance was set once and hasn't moved since, that's unambiguously "the"
// migration event; for one with ordinary activity it's just informational (biggest single credit),
// never asserted as anything more specific than what the raw event itself shows.
async function fetchBalanceEventsAndBiggestCredit(address, cutoffDate) {
  const perDate = new Map();
  let biggestCredit = null; // { date, blockNumber, timestamp, deltaWei }
  let params = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetchJson(`/addresses/${address}/coin-balance-history${query}`);
    const items = res.items || [];
    if (items.length === 0) break;

    let sawOlderThanCutoff = false;
    for (const item of items) {
      const date = dateKey(item.block_timestamp);
      if (!perDate.has(date)) perDate.set(date, item.value);
      if (date < cutoffDate) sawOlderThanCutoff = true;

      try {
        const delta = BigInt(item.delta ?? "0");
        if (delta > 0n && (biggestCredit === null || delta > BigInt(biggestCredit.deltaWei))) {
          biggestCredit = { date, blockNumber: item.block_number, timestamp: item.block_timestamp, deltaWei: delta.toString() };
        }
      } catch {
        // malformed delta — skip, doesn't affect the balance series itself
      }
    }

    if (sawOlderThanCutoff || !res.next_page_params) break;
    params = res.next_page_params;
  }

  return { perDate, biggestCredit };
}

// Identical forward-fill to cexBalanceHistory.js's own — see that file's own comment for why the
// pre-window opening balance matters.
function forwardFill(perDate, startDate, endDate) {
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
  if (isRunning) return;
  isRunning = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cutoffDate = addDays(today, -BACKFILL_DAYS);

    const [{ perDate, biggestCredit }, txRes] = await Promise.all([
      fetchBalanceEventsAndBiggestCredit(MIGRATION_WALLET_ADDRESS, cutoffDate),
      fetchJson(`/addresses/${MIGRATION_WALLET_ADDRESS}/transactions`),
    ]);

    const filled = forwardFill(perDate, cutoffDate, today);
    const series = [];
    for (let d = cutoffDate; d <= today; d = addDays(d, 1)) {
      series.push({ date: d, balance: (filled.get(d) ?? 0n).toString() });
    }

    // Every real transaction this wallet has ever sent or received — no minimum-value filter (see
    // this file's own header comment: for THIS wallet specifically, any activity at all is the
    // signal being watched for, not just large moves).
    const transactions = (txRes.items || [])
      .filter((tx) => tx.value && tx.status !== "error")
      .slice(0, MAX_TRANSACTIONS_SHOWN)
      .map((tx) => ({
        hash: tx.hash,
        from: tx.from?.hash || null,
        to: tx.to?.hash || null,
        value: tx.value,
        timestamp: tx.timestamp,
      }));

    await setMigrationWalletCache({
      balance: (filled.get(today) ?? 0n).toString(),
      series,
      migrationEvent: biggestCredit,
      transactions,
    });
    console.log(`🔎 Migration wallet tracker updated — balance ${(filled.get(today) ?? 0n).toString()}, ${transactions.length} transaction(s) on record`);
  } catch (err) {
    console.error("⚠️  Migration wallet tracker refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background refresher. No-op if R2 isn't configured, same as this backend's other caches. */
export function startMigrationWalletTracker() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — migration wallet tracker disabled");
    return;
  }

  console.log(`🔎 Migration wallet tracker started (watching ${MIGRATION_WALLET_ADDRESS}, refreshing every ${POLL_INTERVAL_MS / 1000}s)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, POLL_INTERVAL_MS);
}
