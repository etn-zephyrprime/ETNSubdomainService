// backend/services/tokenBalanceHistoryService.js
//
// Per-token balance-over-time for Core Tier's Balance History panel — a capability that genuinely
// didn't exist before (Blockscout's own coin-balance-history-by-day endpoint is ETN-only; see
// CoreTierBalanceHistory.jsx's own header comment on why that chart was ETN-only until now). Built
// from this app's OWN ingested transfer history instead — the same data PnL replay already uses,
// just summed directly rather than run through the FIFO engine, since a plain balance (unlike a
// cost-basis ledger) doesn't need lots, acquisition order, or self-transfer special-casing: a
// transfer either adds to or removes from this wallet's own on-chain balance, full stop, regardless
// of whether it's a sale, a self-transfer, or a farm deposit (locking tokens in a contract really
// does leave the wallet's own balance, same as an explorer would show).
//
// Returns a SPARSE per-day series (one point per day the balance actually changed, like
// Blockscout's own coin-balance-history convention) — the frontend forward-fills gaps itself via
// balanceHistory.js's buildDailySeries, same as the existing ETN chart already does.
import Decimal from "decimal.js";
import { getTokenTransfersForWallet } from "../db/ingestedTransfers.js";

export async function getTokenBalanceHistory(trackedWallet, tokenAddress) {
  const rows = await getTokenTransfersForWallet(trackedWallet, tokenAddress);
  if (rows.length === 0) return [];

  let running = new Decimal(0);
  const byDay = new Map(); // "YYYY-MM-DD" -> running balance AS OF THE END of that day (Decimal)
  for (const r of rows) {
    const delta = new Decimal(r.amount_decimal || 0);
    running = r.direction === "out" ? running.minus(delta) : running.plus(delta);
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    byDay.set(day, running); // last write for a given day wins — rows are already timestamp-ordered
  }

  return [...byDay.entries()].map(([date, balance]) => ({ date, balance: balance.toString() }));
}
