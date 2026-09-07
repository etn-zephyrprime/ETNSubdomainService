import { query } from "./pool.js";

/** Writes (or overwrites) one wallet's daily rollup — idempotent per (owner, wallet, day), so a
 * scheduler retry or a manual re-run for the same day never creates a duplicate row, it just
 * updates that day's figures to the latest computation. */
export async function upsertPnlSnapshot(ownerWallet, walletAddress, snapshotDate, { totalValueUsd, realizedPnlUsd, unrealizedPnlUsd }) {
  await query(
    `INSERT INTO pnl_snapshots (owner_wallet, wallet_address, snapshot_date, total_value_usd, realized_pnl_usd, unrealized_pnl_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_wallet, wallet_address, snapshot_date)
     DO UPDATE SET total_value_usd = $4, realized_pnl_usd = $5, unrealized_pnl_usd = $6`,
    [ownerWallet.toLowerCase(), walletAddress.toLowerCase(), snapshotDate, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd]
  );
}

/** Daily rollup rows for every wallet address in `walletAddresses`, from `sinceDate` onward,
 * oldest first — the raw material for the value-over-time chart. Callers sum across wallets
 * client-side (or here, see combineSnapshotsByDate below) for the "combined" series; this returns
 * each wallet's own rows unmerged, same "own data, combine at read time" shape
 * useCombinedPortfolio.js's perWallet already uses elsewhere in this app. */
export async function getPnlSnapshotHistory(ownerWallet, walletAddresses, sinceDate) {
  if (walletAddresses.length === 0) return [];
  const res = await query(
    `SELECT wallet_address, snapshot_date, total_value_usd, realized_pnl_usd, unrealized_pnl_usd
     FROM pnl_snapshots
     WHERE owner_wallet = $1 AND wallet_address = ANY($2::text[]) AND snapshot_date >= $3
     ORDER BY snapshot_date ASC`,
    [ownerWallet.toLowerCase(), walletAddresses.map((a) => a.toLowerCase()), sinceDate]
  );
  return (res?.rows || []).map((r) => ({
    walletAddress: r.wallet_address,
    date: r.snapshot_date,
    totalValueUsd: Number(r.total_value_usd),
    realizedPnlUsd: Number(r.realized_pnl_usd),
    unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
  }));
}

/** Merges per-wallet daily rows (as returned by getPnlSnapshotHistory) into one combined series —
 * one point per date any wallet has a row for, forward-filling each wallet's own last-known figures
 * for a date it has no row of its own (a wallet with no row yet as of a given date contributes 0 —
 * it wasn't tracked, or the scheduler hadn't run yet). Same forward-fill shape
 * src/dashboard/utils/balanceHistory.js's mergeBalanceHistories already uses for the analogous
 * balance-history chart, kept server-side here since pnl_snapshots rows never need to reach the
 * frontend unmerged the way balance history's raw Blockscout rows do. */
export function combineSnapshotsByDate(perWalletRows, walletAddresses) {
  const byWallet = new Map(walletAddresses.map((a) => [a.toLowerCase(), []]));
  for (const row of perWalletRows) {
    if (!byWallet.has(row.walletAddress)) byWallet.set(row.walletAddress, []);
    byWallet.get(row.walletAddress).push(row);
  }

  const pointers = new Map([...byWallet.keys()].map((a) => [a, 0]));
  const current = new Map([...byWallet.keys()].map((a) => [a, { totalValueUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0 }]));
  const allDates = [...new Set(perWalletRows.map((r) => r.date))].sort();

  return allDates.map((date) => {
    for (const [address, rows] of byWallet) {
      let p = pointers.get(address);
      while (p < rows.length && rows[p].date <= date) {
        current.set(address, rows[p]);
        p++;
      }
      pointers.set(address, p);
    }
    const totals = { date, totalValueUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0 };
    for (const c of current.values()) {
      totals.totalValueUsd += c.totalValueUsd;
      totals.realizedPnlUsd += c.realizedPnlUsd;
      totals.unrealizedPnlUsd += c.unrealizedPnlUsd;
    }
    return totals;
  });
}

/** The set of snapshot_date values (as 'YYYY-MM-DD' strings) this wallet already has a row for,
 * within [fromDate, toDate] inclusive — lets a caller skip days it's already filled in rather than
 * overwrite them. Used by pnlSnapshotService.js's backfillPnlHistory to stay idempotent/resumable:
 * a wallet interrupted partway through (a crash, a redeploy) picks up where it left off next time
 * instead of redoing already-computed days, and re-running it after the daily scheduler has since
 * filled in more days naturally does no wasted work either. */
export async function getExistingSnapshotDates(ownerWallet, walletAddress, fromDate, toDate) {
  const res = await query(
    `SELECT snapshot_date FROM pnl_snapshots
     WHERE owner_wallet = $1 AND wallet_address = $2 AND snapshot_date BETWEEN $3 AND $4`,
    [ownerWallet.toLowerCase(), walletAddress.toLowerCase(), fromDate, toDate]
  );
  return (res?.rows || []).map((r) => (r.snapshot_date instanceof Date ? r.snapshot_date.toISOString().slice(0, 10) : String(r.snapshot_date)));
}

/** Every (owner_wallet, wallet_address) pair that's currently actively tracked, across EVERY Core
 * tier member — pnlSnapshotScheduler.js's own poll list (it has no single owner to start from the
 * way per-owner features do, it has to enumerate everyone). Deliberately a plain join against
 * tracked_wallets rather than a second cache: this only runs once a day (see that scheduler's own
 * cadence), so a live query is in no way a performance concern here. */
export async function getAllActiveTrackedWalletPairs() {
  const res = await query(
    `SELECT owner_wallet, wallet_address FROM tracked_wallets WHERE removed_at IS NULL ORDER BY owner_wallet`
  );
  return res?.rows || [];
}
