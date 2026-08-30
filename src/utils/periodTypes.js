// src/utils/periodTypes.js
//
// The four fixed PnL reporting periods a statement can be requested for. Duplicated from
// backend/services/periodTypes.js (must stay in sync) — same "fine to drift independently"
// convention this codebase uses for other cross-cutting logic. The frontend only needs this to
// (a) show the picker and (b) compute the exact periodEnd timestamp to submit with a purchase —
// the backend remains the actual authority on what a (periodType, year) claim means when it comes
// time to generate the statement (see that file's own header comment).

export const PERIOD_TYPES = [
  { id: 0, key: "calendarYear", label: "Calendar Year", range: "Jan 1 – Dec 31", startMonth: 0 },
  { id: 1, key: "ukStyle", label: "UK / India / Japan / Canada / South Africa", range: "Apr 1 – Mar 31", startMonth: 3 },
  { id: 2, key: "auStyle", label: "Australia / NZ / Egypt / Pakistan", range: "Jul 1 – Jun 30", startMonth: 6 },
  { id: 3, key: "usStyle", label: "US Federal / Thailand", range: "Oct 1 – Sep 30", startMonth: 9 },
];

const BY_ID = new Map(PERIOD_TYPES.map((p) => [p.id, p]));

/** Same convention as the backend copy: `year` identifies the calendar year the period STARTS
 * in, for every period type. Returns Date objects (UTC boundaries). */
export function computePeriodBoundaries(periodTypeId, year) {
  const type = BY_ID.get(Number(periodTypeId));
  if (!type) throw new Error(`Unknown periodType ${periodTypeId}`);
  const periodStart = new Date(Date.UTC(year, type.startMonth, 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year + 1, type.startMonth, 1, 0, 0, 0));
  return { periodStart, periodEnd };
}

export function isPeriodElapsed(periodTypeId, year, now = new Date()) {
  const { periodEnd } = computePeriodBoundaries(periodTypeId, year);
  return periodEnd <= now;
}

export function periodTypeLabel(periodTypeId) {
  return BY_ID.get(Number(periodTypeId))?.label || `Unknown (${periodTypeId})`;
}
