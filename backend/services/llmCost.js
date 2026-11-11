// What the Claude calls cost (llm_usage_log, migrations/026), set against Core Tier revenue — the monthly
// "does membership cover the AI?" summary (scripts/llmCostReport.js, and a Telegram note to the admins on the
// 1st of each month from contractAlertScheduler.js).
//
// Prices are per million tokens, Anthropic first-party API, as of Nov 2026 — update PRICES if they change.
// Haiku 5.5's rates are for prompts up to 100K tokens (ours are well under). Cache rates: Sonnet 5.5 cache
// reads are published at $0.20; cache writes are taken as 1.25x input (5-minute cache) and Haiku 5.5's cache
// reads as 0.1x input — both estimates, marked in the report.
export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Dollar cost of one usage row (tokens summed); unknown models cost null (shown, not guessed). */
export function rowCostUsd(r) {
  const p = PRICES[r.model];
  if (!p) return null;
  return ((r.inputTokens || 0) * p.input + (r.outputTokens || 0) * p.output + (r.cacheReadTokens || 0) * p.cacheRead + (r.cacheWriteTokens || 0) * p.cacheWrite) / 1e6;
}

/** Totals per kind for a month's usage rows ([{ kind, model, calls, inputTokens, ... }]). */
export function summarizeCosts(rows) {
  const byKind = {};
  let total = 0, unknown = 0, calls = 0;
  for (const r of rows) {
    const c = rowCostUsd(r);
    const k = (byKind[r.kind] ||= { calls: 0, usd: 0, models: new Set() });
    k.calls += r.calls;
    k.models.add(r.model);
    calls += r.calls;
    if (c == null) unknown += r.calls;
    else {
      k.usd += c;
      total += c;
    }
  }
  return { byKind, total, unknown, calls };
}

const KIND = { summary: "Contract summaries", question: "Contract questions", digest: "Daily wallet checks" };
const money = (n) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** The report text (plain; Markdown-safe — no user-supplied text in it). */
export function formatCostReport({ month, rows, revenueEtn, etnUsd, activeMembers }) {
  const s = summarizeCosts(rows);
  const lines = [`💸 *Argus AI costs — ${month}*`, ""];
  if (!s.calls) lines.push("No Claude calls this month.");
  for (const [kind, k] of Object.entries(s.byKind)) lines.push(`${KIND[kind] || kind}: ${k.calls.toLocaleString("en-US")} call${k.calls === 1 ? "" : "s"} · ${money(k.usd)} (${[...k.models].map((m) => m.replace("claude-", "")).join(", ")})`);
  lines.push("", `*Total: ${money(s.total)}*${s.unknown ? ` (+${s.unknown} call(s) on a model with no price set)` : ""}`);
  if (activeMembers) lines.push(`Per active member (${activeMembers}): ${money(s.total / activeMembers)}`);
  if (revenueEtn != null) {
    const revUsd = etnUsd ? revenueEtn * etnUsd : null;
    lines.push("", `Core Tier revenue swept this month: ${Math.round(revenueEtn).toLocaleString("en-US")} ETN${revUsd != null ? ` (≈ ${money(revUsd)})` : ""}`);
    if (revUsd) lines.push(s.total <= revUsd ? `AI costs are ${((s.total / revUsd) * 100).toFixed(1)}% of that — covered.` : `AI costs are more than that revenue (${money(s.total - revUsd)} short).`);
    lines.push("_Revenue is what was swept from the contract this month, which can lag purchases a little._");
  }
  lines.push("_Cache-token prices are partly estimated; see services/llmCost.js._");
  return lines.join("\n");
}

/** "YYYY-MM" -> { from, to } ISO bounds (UTC). Throws on a malformed month. */
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`month must be YYYY-MM, got "${month}"`);
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The month before `now`'s, as "YYYY-MM". */
export function previousMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
