import { query } from "./pool.js";

// The latest ContractFacts per address (migrations/025_contract_check.sql) — see
// services/contractCheck/analyseContract.js for when a row is re-used vs re-analysed.

/** `{ facts, codeHash, implementation, implementationCodeHash, owner, analysedAt }` or null. */
export async function getContractFacts(address) {
  const res = await query(
    `SELECT facts, code_hash, implementation, implementation_code_hash, owner, analysed_at FROM contract_facts WHERE address = $1`,
    [address.toLowerCase()]
  );
  const r = res?.rows?.[0];
  if (!r) return null;
  return { facts: r.facts, codeHash: r.code_hash, implementation: r.implementation, implementationCodeHash: r.implementation_code_hash, owner: r.owner, analysedAt: r.analysed_at };
}

/** Overwrites the address's row with a fresh analysis. */
export async function upsertContractFacts(address, { facts, codeHash, implementation, implementationCodeHash, owner }) {
  await query(
    `INSERT INTO contract_facts (address, code_hash, implementation, implementation_code_hash, owner, facts, analysed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (address) DO UPDATE SET code_hash = EXCLUDED.code_hash, implementation = EXCLUDED.implementation,
       implementation_code_hash = EXCLUDED.implementation_code_hash, owner = EXCLUDED.owner, facts = EXCLUDED.facts, analysed_at = now()`,
    [address.toLowerCase(), codeHash, implementation, implementationCodeHash, owner, facts]
  );
}
