import { query } from "./pool.js";

/** Writes (or overwrites) one wallet's daily rollup for ONE category — idempotent per (owner,
 * wallet, category, day), same reasoning as pnlSnapshots.js's own upsertPnlSnapshot. */
export async function upsertPnlCategorySnapshot(ownerWallet, walletAddress, category, snapshotDate, { totalValueUsd, realizedPnlUsd, unrealizedPnlUsd }) {
  await query(
    `INSERT INTO pnl_category_snapshots (owner_wallet, wallet_address, category, snapshot_date, total_value_usd, realized_pnl_usd, unrealized_pnl_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_wallet, wallet_address, category, snapshot_date)
     DO UPDATE SET total_value_usd = $5, realized_pnl_usd = $6, unrealized_pnl_usd = $7`,
    [ownerWallet.toLowerCase(), walletAddress.toLowerCase(), category, snapshotDate, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd]
  );
}

/** Daily rollup rows for every wallet address in `walletAddresses`, for ONE category, from
 * `sinceDate` onward, oldest first — same "own data, combine at read time" shape as
 * pnlSnapshots.js's own getPnlSnapshotHistory. */
export async function getPnlCategorySnapshotHistory(ownerWallet, walletAddresses, category, sinceDate) {
  if (walletAddresses.length === 0) return [];
  const res = await query(
    `SELECT wallet_address, snapshot_date, total_value_usd, realized_pnl_usd, unrealized_pnl_usd
     FROM pnl_category_snapshots
     WHERE owner_wallet = $1 AND wallet_address = ANY($2::text[]) AND category = $3 AND snapshot_date >= $4
     ORDER BY snapshot_date ASC`,
    [ownerWallet.toLowerCase(), walletAddresses.map((a) => a.toLowerCase()), category, sinceDate]
  );
  return (res?.rows || []).map((r) => ({
    walletAddress: r.wallet_address,
    // Same Date->string normalization as pnlSnapshots.js's own getPnlSnapshotHistory, for the
    // exact same reason — see that function's own comment.
    date: r.snapshot_date instanceof Date ? r.snapshot_date.toISOString().slice(0, 10) : String(r.snapshot_date),
    totalValueUsd: Number(r.total_value_usd),
    realizedPnlUsd: Number(r.realized_pnl_usd),
    unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
  }));
}

/** Merges per-wallet daily rows into one combined series — identical logic to pnlSnapshots.js's
 * own combineSnapshotsByDate (not shared from there only because that one isn't exported for reuse
 * outside its own file; the row shape and merge rules are otherwise exactly the same). */
export function combineCategorySnapshotsByDate(perWalletRows, walletAddresses) {
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

/** The set of snapshot_date values this wallet already has a row for, in ONE category, within
 * [fromDate, toDate] inclusive — same resumable-backfill role as pnlSnapshots.js's own
 * getExistingSnapshotDates, scoped to a category since a wallet can be backfilled for one category
 * independently of another (e.g. its farm/staking history finishes before its liquidity history
 * does, or vice versa). */
export async function getExistingCategorySnapshotDates(ownerWallet, walletAddress, category, fromDate, toDate) {
  const res = await query(
    `SELECT snapshot_date FROM pnl_category_snapshots
     WHERE owner_wallet = $1 AND wallet_address = $2 AND category = $3 AND snapshot_date BETWEEN $4 AND $5`,
    [ownerWallet.toLowerCase(), walletAddress.toLowerCase(), category, fromDate, toDate]
  );
  return (res?.rows || []).map((r) => (r.snapshot_date instanceof Date ? r.snapshot_date.toISOString().slice(0, 10) : String(r.snapshot_date)));
}
