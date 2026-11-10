// backend/scripts/seedKnownContracts.js
//
// Writes the known-contracts seed list (services/contractCheck/knownContracts.js) into the
// known_contracts table (migrations/025). Safe to re-run: each row is upserted by address.
//
// Usage (from backend/):  node scripts/seedKnownContracts.js            dry run (lists what it would write)
//                         node scripts/seedKnownContracts.js --apply
import dotenv from "dotenv";
import { KNOWN_CONTRACTS_SEED } from "../services/contractCheck/knownContracts.js";
import { upsertKnownContract } from "../db/knownContracts.js";

dotenv.config();
const apply = process.argv.includes("--apply");

for (const k of KNOWN_CONTRACTS_SEED) {
  console.log(`${apply ? "upsert" : "would upsert"}  ${k.address.toLowerCase()}  ${k.category.padEnd(14)} ${k.label}`);
  if (apply) await upsertKnownContract(k);
}
console.log(`\n${KNOWN_CONTRACTS_SEED.length} contract(s)${apply ? " written" : " — dry run, add --apply to write"}`);
process.exit(0);
