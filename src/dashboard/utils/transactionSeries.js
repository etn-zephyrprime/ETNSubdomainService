/**
 * Reconstructs an approximate cumulative transaction series from daily new-transaction counts
 * and the current all-time total. Blockscout doesn't expose historical values for that total.
 */
export function reconstructCumulativeTransactions(dailyChartData, currentTotal) {
  if (!Array.isArray(dailyChartData) || !Number.isFinite(currentTotal)) return [];

  const oldestFirst = [...dailyChartData].reverse();
  let runningLaterSum = 0;
  const series = new Array(oldestFirst.length);

  for (let i = oldestFirst.length - 1; i >= 0; i--) {
    series[i] = { label: oldestFirst[i].date, value: currentTotal - runningLaterSum };
    const count = Number(oldestFirst[i].transaction_count);
    runningLaterSum += Number.isFinite(count) ? count : 0;
  }

  return series;
}

/**
 * Merges Blockscout's recent daily counts with the backend's older independently-scanned counts,
 * returning a contiguous newest-first series in the shape expected by the cumulative helper.
 */
export function mergeDailyTransactionCounts(blockscoutChartData, ourDays, daysBack = 90) {
  const bsMap = new Map(
    (blockscoutChartData || [])
      .map((d) => [d.date, Number(d.transactions_count ?? d.transaction_count)])
      .filter(([, count]) => Number.isFinite(count))
  );
  const merged = [];
  const today = new Date();
  let started = false;

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    let count = null;
    if (bsMap.has(dateStr)) count = bsMap.get(dateStr);
    else if (ourDays?.[dateStr]) count = ourDays[dateStr].txCount;

    if (count == null) {
      if (!started) continue;
      break;
    }
    started = true;
    merged.push({ date: dateStr, transaction_count: count });
  }

  return merged;
}
