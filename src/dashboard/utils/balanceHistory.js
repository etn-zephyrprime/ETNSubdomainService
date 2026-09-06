import { ethers } from "ethers";

/**
 * Merges N wallets' own coin-balance-history-by-day series (each `{date, value}`, value a wei
 * string, sorted ascending by date — Blockscout's own guarantee, see AddressLookup.jsx's own
 * comment on the same endpoint) into one combined series: one point per date where ANY wallet's
 * balance changed.
 *
 * Blockscout's history is SPARSE — confirmed live (a real wallet's history jumps
 * 2026-06-09 -> 2026-06-19 -> 2026-06-22 with no entries for the days between) — only days the
 * balance actually moved get an entry at all. Naively summing whatever happens to land on the
 * exact same date across wallets would undercount on almost every date, since two wallets rarely
 * change balance on the same day. This forward-fills each wallet's last-known balance for any
 * date it has no entry of its own (a wallet with no entry yet as of a given date is treated as 0
 * — its balance before its first-ever recorded change) before summing.
 *
 * Returns `{ label, value }[]` (value a plain float ETN number, not wei) — directly usable as
 * SparklineChart's `data` prop.
 */
export function mergeBalanceHistories(perWalletItems) {
  const pointers = perWalletItems.map(() => 0);
  const currentWei = perWalletItems.map(() => 0n);
  const allDates = [...new Set(perWalletItems.flatMap((items) => items.map((i) => i.date)))].sort();

  return allDates.map((date) => {
    perWalletItems.forEach((items, i) => {
      while (pointers[i] < items.length && items[pointers[i]].date <= date) {
        currentWei[i] = BigInt(items[pointers[i]].value);
        pointers[i] += 1;
      }
    });
    const totalWei = currentWei.reduce((sum, v) => sum + v, 0n);
    return { label: date, value: parseFloat(ethers.formatEther(totalWei)) };
  });
}
