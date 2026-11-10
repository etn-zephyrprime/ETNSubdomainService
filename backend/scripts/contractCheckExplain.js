// backend/scripts/contractCheckExplain.js
//
// Live check of the Contract Check explanation layer (services/contractCheck/explain.js) — calls Claude
// for real (needs ANTHROPIC_API_KEY), so it costs a few cents per run. Prints whether the answer came
// from Claude or fell back to the template, and the token usage logged to llm_usage_log.
//
// Usage (from backend/):
//   node scripts/contractCheckExplain.js <address | name.etn>                      the summary
//   node scripts/contractCheckExplain.js <address | name.etn> "Can they mint?"     a question
import dotenv from "dotenv";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { explainContract, answerQuestion, getClient, SUMMARY_MODEL, QA_MODEL } from "../services/contractCheck/explain.js";
import { resolveEtnName } from "../utils/primaryNameResolver.js";

dotenv.config();

const [input, question] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/contractCheckExplain.js <address | name.etn> ["question"]');
  process.exit(1);
}
if (!getClient()) console.warn("⚠️  ANTHROPIC_API_KEY isn't set — you'll see the template answer, not Claude's.\n");
const address = input.toLowerCase().endsWith(".etn") ? await resolveEtnName(contractCheckProvider(), input) : input;
if (!address) {
  console.error(`${input} doesn't resolve to an address`);
  process.exit(1);
}
const facts = await analyseContract(address);
console.log(`Facts: overall ${facts.overall}, flags ${facts.riskFlags.map((f) => f.id).join(", ") || "none"}`);
console.log(`Model: ${question ? QA_MODEL : SUMMARY_MODEL}\n`);
const out = question ? await answerQuestion(facts, question) : await explainContract(facts);
console.log(JSON.stringify(out, null, 2));
console.log(`\nSource: ${out.source}${out.source === "template" ? " (Claude unavailable, refused, or failed validation twice — see the logs above)" : ""}`);
process.exit(0);
