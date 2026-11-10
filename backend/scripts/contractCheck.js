// backend/scripts/contractCheck.js
//
// Prints a contract's ContractFacts (services/contractCheck/analyseContract.js) — read-only by default.
//
// Usage (from backend/):
//   node scripts/contractCheck.js <address>             analyse fresh, print the facts JSON
//   node scripts/contractCheck.js <address> --cache     go through the cache (and write to it)
//   node scripts/contractCheck.js name.etn              resolve a .etn name first
import dotenv from "dotenv";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { resolveEtnName } from "../utils/primaryNameResolver.js";

dotenv.config();

const [input, ...flags] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node scripts/contractCheck.js <address | name.etn> [--cache]");
  process.exit(1);
}
const useCache = flags.includes("--cache");

const address = input.toLowerCase().endsWith(".etn") ? await resolveEtnName(contractCheckProvider(), input) : input;
if (!address) {
  console.error(`${input} doesn't resolve to an address`);
  process.exit(1);
}
const facts = await analyseContract(address, { force: !useCache, persist: useCache });
console.log(JSON.stringify(facts, null, 2));
process.exit(0);
