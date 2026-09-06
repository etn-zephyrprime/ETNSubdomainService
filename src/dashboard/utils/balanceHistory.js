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

/**
 * Builds a `date (YYYY-MM-DD) -> USD price` lookup from useEtnPriceHistory's own `points`
 * (`{timestamp, priceUsd}[]`) — backed by price_points (see that hook's own comment), which is
 * DENSE in practice (confirmed live: one point per calendar day, no gaps, back to 2019-07-10), so
 * this is mostly a plain exact-date lookup. Still falls back to the closest earlier date for any
 * date not present, same defensive spirit as mergeBalanceHistories's forward-fill, in case a given
 * day is ever genuinely missing from price_points.
 */
export function buildEtnPriceLookup(points) {
  const sorted = [...points]
    .map((p) => ({ date: p.timestamp.slice(0, 10), priceUsd: p.priceUsd }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return (date) => {
    let price = null;
    for (const p of sorted) {
      if (p.date > date) break;
      price = p.priceUsd;
    }
    return price;
  };
}

/** Converts an ETN-denominated `{label, value}[]` series to USD using `priceLookup` (see
 * buildEtnPriceLookup) — a point whose date has no known price (shouldn't happen given how dense
 * the series is, but see that function's own fallback) is dropped rather than shown as $0, same
 * "omit rather than fake a number" convention used everywhere else USD values appear in this app. */
export function convertSeriesToUsd(series, priceLookup) {
  return series
    .map((point) => {
      const price = priceLookup(point.label);
      return price == null ? null : { label: point.label, value: point.value * price };
    })
    .filter(Boolean);
}
