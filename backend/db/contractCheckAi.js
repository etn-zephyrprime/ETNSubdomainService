import { query } from "./pool.js";

// Contract Check phase 2 tables (migrations/026_contract_check_ai.sql): cached summaries, the daily
// question quota, and the Claude usage log.

/** `{ factsHash, promptVersion, model, source, summary }` for an address, or null. */
export async function getContractSummary(address) {
  const res = await query(`SELECT facts_hash, prompt_version, model, source, summary FROM contract_summaries WHERE address = $1`, [address.toLowerCase()]);
  const r = res?.rows?.[0];
  return r ? { factsHash: r.facts_hash, promptVersion: r.prompt_version, model: r.model, source: r.source, summary: r.summary } : null;
}

export async function upsertContractSummary(address, { factsHash, promptVersion, model, source, summary }) {
  await query(
    `INSERT INTO contract_summaries (address, facts_hash, prompt_version, model, source, summary, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (address) DO UPDATE SET facts_hash = EXCLUDED.facts_hash, prompt_version = EXCLUDED.prompt_version,
       model = EXCLUDED.model, source = EXCLUDED.source, summary = EXCLUDED.summary, created_at = now()`,
    [address.toLowerCase(), factsHash, promptVersion, model, source, summary]
  );
}

/** Questions this wallet has asked today (UTC). 0 when the database isn't configured. */
export async function getQuestionCount(wallet, day) {
  const res = await query(`SELECT count FROM contract_qa_usage WHERE wallet = $1 AND day = $2`, [wallet.toLowerCase(), day]);
  return Number(res?.rows?.[0]?.count || 0);
}

/** Questions asked since each period start (questionQuota.js periodStarts): { day, week, month }. One query. */
export async function getQuestionUsage(wallet, starts) {
  const res = await query(
    `SELECT COALESCE(SUM(count) FILTER (WHERE day >= $2), 0) AS day,
            COALESCE(SUM(count) FILTER (WHERE day >= $3), 0) AS week,
            COALESCE(SUM(count) FILTER (WHERE day >= $4), 0) AS month
     FROM contract_qa_usage WHERE wallet = $1 AND day >= LEAST($3::date, $4::date)`,
    [wallet.toLowerCase(), starts.day, starts.week, starts.month]
  );
  const r = res?.rows?.[0] || {};
  return { day: Number(r.day || 0), week: Number(r.week || 0), month: Number(r.month || 0) };
}

/** Counts one question for today and returns the new total (null when the database isn't configured). */
export async function incrementQuestionCount(wallet, day) {
  const res = await query(
    `INSERT INTO contract_qa_usage (wallet, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (wallet, day) DO UPDATE SET count = contract_qa_usage.count + 1
     RETURNING count`,
    [wallet.toLowerCase(), day]
  );
  return res?.rows?.[0]?.count != null ? Number(res.rows[0].count) : null;
}

/** One row per Claude API call. */
export async function logLlmUsage({ kind, model, contractAddress = null, wallet = null, attempt = 1, usage = null, outcome }) {
  await query(
    `INSERT INTO llm_usage_log (kind, model, contract_address, wallet, attempt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [kind, model, contractAddress?.toLowerCase() || null, wallet?.toLowerCase() || null, attempt, usage?.input_tokens ?? null, usage?.output_tokens ?? null, usage?.cache_read_input_tokens ?? null, usage?.cache_creation_input_tokens ?? null, outcome]
  );
}

/** Claude usage in [from, to): one row per kind + model with summed tokens. */
export async function llmUsageBetween(from, to) {
  const res = await query(
    `SELECT kind, model, COUNT(*)::int AS calls, COALESCE(SUM(input_tokens), 0)::bigint AS input, COALESCE(SUM(output_tokens), 0)::bigint AS output,
            COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read, COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write
     FROM llm_usage_log WHERE created_at >= $1 AND created_at < $2 GROUP BY kind, model ORDER BY kind, model`,
    [from, to]
  );
  return (res?.rows || []).map((r) => ({ kind: r.kind, model: r.model, calls: r.calls, inputTokens: Number(r.input), outputTokens: Number(r.output), cacheReadTokens: Number(r.cache_read), cacheWriteTokens: Number(r.cache_write) }));
}

/** Core Tier subscription revenue swept from the contract in [from, to), in ETN. */
export async function revenueSweptBetween(from, to) {
  const res = await query(`SELECT COALESCE(SUM(amount_swept_wei), 0)::text AS wei FROM subscription_revenue_sweeps WHERE executed_at >= $1 AND executed_at < $2`, [from, to]);
  return Number(BigInt(res?.rows?.[0]?.wei || "0") / 10n ** 14n) / 1e4;
}
