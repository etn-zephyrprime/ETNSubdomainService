// Free-text Contract Check questions per Core member (each one is a Claude API call): at most 5 a day, 20 a
// week and 50 a month — all three apply, so whichever runs out first stops new questions until it resets.
// Periods are UTC calendar periods: the day resets at 00:00 UTC, the week on Monday 00:00 UTC, the month on
// the 1st. Counts come from contract_qa_usage (one row per wallet per day). The instant chip answers and the
// shared, cached contract summary aren't questions and aren't counted. Pure apart from the env overrides.
export const QUESTION_LIMITS = {
  day: Number(process.env.CONTRACT_QA_DAILY_LIMIT) || 5,
  week: Number(process.env.CONTRACT_QA_WEEKLY_LIMIT) || 20,
  month: Number(process.env.CONTRACT_QA_MONTHLY_LIMIT) || 50,
};

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** First day (YYYY-MM-DD, UTC) of the current day, ISO week (Monday) and month. */
export function periodStarts(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekMs = dayMs - ((d.getUTCDay() + 6) % 7) * DAY_MS; // Monday
  const monthMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { day: iso(dayMs), week: iso(weekMs), month: iso(monthMs) };
}

/** When each period next resets (ISO timestamps). */
function resets(nowMs) {
  const s = periodStarts(nowMs);
  const d = new Date(nowMs);
  return {
    day: new Date(Date.parse(s.day) + DAY_MS).toISOString(),
    week: new Date(Date.parse(s.week) + 7 * DAY_MS).toISOString(),
    month: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

const PERIOD_WORD = { day: "today's", week: "this week's", month: "this month's" };
const RESET_WORD = { day: "at 00:00 UTC", week: "on Monday (00:00 UTC)", month: "on the 1st (00:00 UTC)" };

/**
 * `used` = { day, week, month } questions asked so far in each period. Returns
 * { remaining, remainingBy: { day, week, month }, blockedBy: "day" | "week" | "month" | null, resetsAt, message }.
 * `blockedBy` is the period that's run out (the longest one, if several have — it resets last).
 */
export function quotaStatus(used, limits = QUESTION_LIMITS, nowMs = Date.now()) {
  const remainingBy = {};
  for (const p of ["day", "week", "month"]) remainingBy[p] = Math.max(0, limits[p] - (used[p] || 0));
  const remaining = Math.min(remainingBy.day, remainingBy.week, remainingBy.month);
  const blockedBy = remaining > 0 ? null : ["month", "week", "day"].find((p) => remainingBy[p] === 0);
  const resetsAt = blockedBy ? resets(nowMs)[blockedBy] : null;
  const message = blockedBy ? `You've used ${PERIOD_WORD[blockedBy]} ${limits[blockedBy]} questions — more ${RESET_WORD[blockedBy]}` : null;
  return { remaining, remainingBy, blockedBy, resetsAt, message };
}
