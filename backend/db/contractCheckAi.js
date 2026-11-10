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
