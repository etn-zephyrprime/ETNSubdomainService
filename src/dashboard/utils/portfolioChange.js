// 24h change of a set of holdings at their CURRENT quantities: what they're worth now vs. what
// those same quantities would have been worth 24h ago (each part's value now / (1 + its token's
// 24h price change)). Deposits and withdrawals in the last 24h therefore never show up as
// "performance" — this is price movement only.
//
// `parts`: [{ value, change }] — `value` current USD value, `change` the token's fractional 24h
// price change (0.2 = +20%) or null/undefined when unknown. A part with no known change is left out
// of the ratio entirely (rather than assumed flat, which would dilute the figure toward 0%);
// `coverage` reports how much of the total value the figure is actually based on, so a caller can
// flag a partial figure. Returns null when nothing has a known change.
export function computePortfolioChange(parts) {
  let totalValue = 0;
  let coveredNow = 0;
  let coveredThen = 0;
  for (const { value, change } of parts) {
    if (!(value > 0)) continue;
    totalValue += value;
    if (change == null || !Number.isFinite(change) || change <= -1) continue;
    coveredNow += value;
    coveredThen += value / (1 + change);
  }
  if (coveredNow === 0 || coveredThen === 0) return null;
  return { pct: coveredNow / coveredThen - 1, coverage: coveredNow / totalValue };
}
