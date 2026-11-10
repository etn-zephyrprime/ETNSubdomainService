// Contract Check explanation layer: Claude words ContractFacts in plain English. Facts decide everything
// (flags, overall, every number); this module only explains them, and checks the result in code.
//
//   explainContract(facts)            the per-contract summary + fixed-question answers — cached per contract
//                                     (memory + contract_summaries), shared by every user
//   answerQuestion(facts, question)   a free-text question, grounded in the same facts + source
//
// Both: structured JSON output (output_config.format), validated by validateExplanation.js; one retry with
// the problems spelled out, then the template answer built from the facts alone. The API key lives only on
// the backend (ANTHROPIC_API_KEY); without it every answer is the template. Unverified contracts never get
// bytecode sent — Claude sees the facts only, and the limited-signals notice is added in code.
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, PROMPT_VERSION, SUMMARY_SCHEMA, ANSWER_SCHEMA, SUMMARY_TASK, questionTask, buildUserContent, LIMITED_SIGNALS_NOTICE, DISCLAIMER, CHIPS } from "./prompts.js";
import { validateExplanation, allowedFromFacts } from "./validateExplanation.js";
import { templateSummary, templateAnswer } from "./templateExplanation.js";
import { getSourceFiles, sourceForPrompt } from "./contractSource.js";
import { getContractSummary, upsertContractSummary, logLlmUsage } from "../../db/contractCheckAi.js";

export const SUMMARY_MODEL = process.env.CONTRACT_SUMMARY_MODEL || "claude-sonnet-5-5";
export const QA_MODEL = process.env.CONTRACT_QA_MODEL || "claude-haiku-5-5";
const MAX_TOKENS = 16000;
const MAX_QUESTION_CHARS = 500;

let client = null;
/** The Anthropic client, or null when no key is configured (every answer is then the template). */
export function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

const sourceAvailable = (facts) => {
  const s = facts.proxy?.isProxy ? facts.proxy.implementationVerified : facts.verification?.status;
  return s === "verified" || s === "verifiedTwin";
};

/** A hash of what a summary depends on — a re-analysis that only moves timestamps or small holder
 * shifts keeps the cached summary; anything material re-writes it. */
export function summaryFactsHash(facts) {
  const material = {
    v: PROMPT_VERSION,
    identity: { known: facts.identity.known?.label || null, name: facts.identity.contractName, deployerKnown: facts.identity.deployerKnown?.label || null },
    verification: facts.verification.status,
    proxy: facts.proxy,
    ownership: facts.ownership,
    powers: facts.powers,
    flags: facts.riskFlags,
    overall: facts.overall,
    token: facts.token ? { symbol: facts.token.symbol, type: facts.token.type, top10: Math.round(facts.token.top10PctExcludingBurn ?? -1) } : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

/** One structured-output call. Returns `{ parsed, usage, refusal }`. */
async function callClaude(api, { model, schema, facts, sourceText, task, retryNote }) {
  const content = buildUserContent(facts, sourceText, retryNote ? `${task}\n\nYour previous answer was rejected by our checks: ${retryNote}\nAnswer again, using only what the facts show.` : task);
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  };
  // Server-side refusal fallback on the Sonnet summary route (Claude API: the "default" form routes by
  // refusal category). Haiku has no server-side fallback — a refusal there falls back to the template.
  const res = model.startsWith("claude-sonnet") || model.startsWith("claude-opus")
    ? await api.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await api.messages.create(params);
  if (res.stop_reason === "refusal") return { parsed: null, usage: res.usage, refusal: true };
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { parsed, usage: res.usage, refusal: false, stopReason: res.stop_reason };
}

/**
 * Ask Claude, validate, retry once, else the template. Logs every call.
 * Returns `{ result, source: "claude"|"template", attempts }`.
 */
async function generate({ api, kind, model, schema, facts, task, template, wallet = null, sourceFiles = null }) {
  if (!api) return { result: template(), source: "template", attempts: 0 };
  let sourceText = "";
  if (sourceAvailable(facts)) {
    try {
      sourceText = sourceForPrompt(sourceFiles ?? (await getSourceFiles(facts)), facts).text;
    } catch {
      sourceText = ""; // explorer down: explain from the facts alone (the prompt says source is unavailable)
    }
  }
  const allowed = allowedFromFacts(facts);
  let retryNote = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let outcome = "error", out = null;
    try {
      out = await callClaude(api, { model, schema, facts, sourceText, task, retryNote });
      if (out.refusal) outcome = "refusal";
      else if (!out.parsed) outcome = "invalid";
      else {
        const problems = validateExplanation(out.parsed, facts, { allowed });
        if (!problems.length) outcome = "ok";
        else {
          outcome = "invalid";
          retryNote = problems.slice(0, 6).join("; ");
        }
      }
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError || (err instanceof Anthropic.APIError && err.status >= 500)) console.warn(`⚠️  Contract Check: Claude unavailable (${err.status || err.name}):`, err.message);
      else console.warn("⚠️  Contract Check: Claude call failed:", err.message);
    }
    await logLlmUsage({ kind, model, contractAddress: facts.address, wallet, attempt, usage: out?.usage, outcome }).catch(() => {});
    if (outcome === "ok") return { result: out.parsed, source: "claude", attempts: attempt };
    if (outcome === "refusal" || outcome === "error") break; // a refusal or outage won't fix itself on a retry
    if (!retryNote) retryNote = "the answer wasn't valid JSON for the schema";
  }
  return { result: template(), source: "template", attempts: 2 };
}

/** Code-added parts every response carries, whatever produced the wording. */
function finish(facts, body) {
  return {
    ...body,
    overall: facts.overall, // always the computed value
    riskFlags: facts.riskFlags,
    notice: sourceAvailable(facts) ? null : LIMITED_SIGNALS_NOTICE,
    disclaimer: DISCLAIMER,
  };
}

const summaryMemo = new Map(); // address -> { hash, value }

/** The cached summary for a contract (facts from analyseContract). */
export async function explainContract(facts, { api = getClient(), sourceFiles = null } = {}) {
  const hash = summaryFactsHash(facts);
  const m = summaryMemo.get(facts.address);
  if (m?.hash === hash) return m.value;
  const stored = await getContractSummary(facts.address).catch(() => null);
  let value;
  if (stored && stored.factsHash === hash && stored.promptVersion === PROMPT_VERSION) {
    value = finish(facts, { summary: stored.summary, source: stored.source, model: stored.model });
  } else {
    const g = await generate({ api, kind: "summary", model: SUMMARY_MODEL, schema: SUMMARY_SCHEMA, facts, task: SUMMARY_TASK, template: () => templateSummary(facts), sourceFiles });
    const model = g.source === "claude" ? SUMMARY_MODEL : null;
    // A template summary (Claude down / failing) is cached briefly in memory only, so the next view retries Claude.
    if (g.source === "claude") await upsertContractSummary(facts.address, { factsHash: hash, promptVersion: PROMPT_VERSION, model, source: g.source, summary: g.result }).catch(() => {});
    value = finish(facts, { summary: g.result, source: g.source, model });
    if (g.source !== "claude") return value;
  }
  if (summaryMemo.size > 500) summaryMemo.delete(summaryMemo.keys().next().value);
  summaryMemo.set(facts.address, { hash, value });
  return value;
}

/** A free-text question about a contract. The caller enforces the daily quota and rate limits. */
export async function answerQuestion(facts, question, { api = getClient(), wallet = null, sourceFiles = null } = {}) {
  const q = String(question || "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error("Empty question");
  const g = await generate({ api, kind: "question", model: QA_MODEL, schema: ANSWER_SCHEMA, facts, task: questionTask(q), template: () => templateAnswer(facts), wallet, sourceFiles });
  return finish(facts, { answer: g.result.answer, answerable: g.result.answerable, source: g.source });
}

export { CHIPS };
