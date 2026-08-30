// backend/services/periodTypes.js
//
// The four fixed PnL reporting periods (see the "fixed periods + revised pricing" build brief) —
// calendar math only, no contract/DB dependency. PremiumSubscription.sol logs periodType/year
// purely as caller-supplied labels (see its own header comment); this backend is the actual
// authority on what boundaries a given (periodType, year) means — pnlStatementGenerator.js always
// recomputes boundaries from here rather than trusting the on-chain periodEnd value for the real
// FIFO slice (that on-chain value only ever gates "has this period already ended" at payment time).
//
// Duplicated in src/utils/periodTypes.js for the frontend (must stay in sync) — same "fine to
// drift independently" convention this codebase uses for other cross-cutting logic (see e.g.
// queryLogsChunked, duplicated per-file rather than shared, per those files' own comments).

export const PERIOD_TYPES = [
  { id: 0, key: "calendarYear", label: "Calendar Year", range: "Jan 1 – Dec 31", startMonth: 0 },
  { id: 1, key: "ukStyle", label: "UK / India / Japan / Canada / South Africa", range: "Apr 1 – Mar 31", startMonth: 3 },
  { id: 2, key: "auStyle", label: "Australia / NZ / Egypt / Pakistan", range: "Jul 1 – Jun 30", startMonth: 6 },
  { id: 3, key: "usStyle", label: "US Federal / Thailand", range: "Oct 1 – Sep 30", startMonth: 9 },
];

const BY_ID = new Map(PERIOD_TYPES.map((p) => [p.id, p]));

/**
 * Exact UTC boundaries for (periodTypeId, year). Convention: `year` always identifies the
 * calendar year the period STARTS in, for every period type — e.g. ukStyle year=2024 means
 * Apr 1 2024 through Mar 31 2025 (periodEnd = Apr 1 2025 00:00:00 UTC, exclusive). CalendarYear's
 * own start-year and "the year" are the same thing, so this convention is a no-op for that type.
 * Uses Date.UTC's own month/leap-year normalization — no hand-rolled leap-year special-casing.
 */
export function computePeriodBoundaries(periodTypeId, year) {
  const type = BY_ID.get(Number(periodTypeId));
  if (!type) throw new Error(`Unknown periodType ${periodTypeId}`);

  const periodStart = new Date(Date.UTC(year, type.startMonth, 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year + 1, type.startMonth, 1, 0, 0, 0)); // exclusive
  return { periodStart, periodEnd };
}

/** True if (periodTypeId, year)'s period has fully elapsed as of `now` (defaults to real now) —
 * the same full-period-only rule the contract enforces on its own caller-supplied periodEnd,
 * recomputed here from the authoritative boundaries instead of trusting that raw value. */
export function isPeriodElapsed(periodTypeId, year, now = new Date()) {
  const { periodEnd } = computePeriodBoundaries(periodTypeId, year);
  return periodEnd <= now;
}

export function periodTypeLabel(periodTypeId) {
  return BY_ID.get(Number(periodTypeId))?.label || `Unknown (${periodTypeId})`;
}
