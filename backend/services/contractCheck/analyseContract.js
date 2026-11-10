// Contract Check entry point: ContractFacts for an address, shared across all users.
//
// Cache (contract_facts, migrations/025): every call does three cheap RPC reads — code hash, EIP-1967
// implementation, owner() — and re-uses the stored analysis only if all three match and it's younger than
// 24h (1h if that analysis was incomplete, e.g. Blockscout was down). Anything else re-analyses in full.
// A short in-memory layer in front keeps repeat views from re-reading the JSONB row (Supabase egress).
//
// The cache-refresh diff: when a contract that was cached is re-checked and its owner, implementation or
// code hash differs from the stored row, the change goes to contract_changes (migrations/027) — the
// watchlist alerts (utils/contractAlertScheduler.js) read it from there.
import { ethers } from "ethers";
import { fetchContractData, fetchFingerprint, contractCheckProvider } from "./fetchContractData.js";
import { buildFacts, FACTS_SCHEMA_VERSION } from "./buildFacts.js";
import { getContractFacts, upsertContractFacts } from "../../db/contractFacts.js";
import { insertContractChange } from "../../db/contractAlerts.js";

const FRESH_MS = 24 * 3600 * 1000;
const INCOMPLETE_FRESH_MS = 3600 * 1000;
const MEMO_MS = 10 * 60 * 1000;
const MEMO_MAX = 500;
const memo = new Map(); // address -> { facts, fingerprint, at }
const inFlight = new Map(); // address -> Promise (one analysis per address at a time)

const sameFingerprint = (a, b) => a && b && a.codeHash === b.codeHash && a.implementation === b.implementation && a.owner === b.owner;
const fresh = (facts, analysedAtMs) => facts?.schemaVersion === FACTS_SCHEMA_VERSION && Date.now() - analysedAtMs < (facts.incomplete ? INCOMPLETE_FRESH_MS : FRESH_MS);

/** What changed between a stored fingerprint and a fresh one: [{ field, from, to }] (empty if nothing). */
export function fingerprintChanges(before, after) {
  if (!before || !after) return [];
  return ["owner", "implementation", "codeHash"].filter((k) => (before[k] || null) !== (after[k] || null)).map((field) => ({ field, from: before[field] || null, to: after[field] || null }));
}

function remember(address, facts, fingerprint) {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(address, { facts, fingerprint, at: Date.now() });
}

/**
 * @param addressInput a contract address
 * @param opts.force re-analyse even if the cache matches; opts.persist (default true) write the result
 * @returns ContractFacts
 */
export async function analyseContract(addressInput, { force = false, persist = true, provider = contractCheckProvider() } = {}) {
  const address = ethers.getAddress(addressInput).toLowerCase();
  if (!force) {
    const m = memo.get(address);
    if (m && Date.now() - m.at < MEMO_MS && fresh(m.facts, Date.parse(m.facts.analysedAt))) return m.facts;
  }
  if (inFlight.has(address)) return inFlight.get(address);
  const job = (async () => {
    const fingerprint = await fetchFingerprint(address, provider);
    const row = await getContractFacts(address).catch(() => null);
    const stored = row ? { codeHash: row.codeHash, implementation: row.implementation, owner: row.owner } : null;
    if (!force && row && fresh(row.facts, new Date(row.analysedAt).getTime()) && sameFingerprint(fingerprint, stored)) {
      remember(address, row.facts, fingerprint);
      return row.facts;
    }
    const facts = buildFacts(await fetchContractData(address, { provider }));
    const changes = fingerprintChanges(stored, fingerprint);
    if (changes.length && persist) {
      const label = facts.identity?.known?.label || facts.token?.symbol || facts.identity?.contractName || null;
      await insertContractChange(address, changes, label).catch((err) => console.warn(`⚠️  Contract Check: couldn't record the change to ${address}:`, err.message));
      console.log(`🔎 Contract Check: ${label || address} changed — ${changes.map((c) => c.field).join(", ")}`);
    }
    if (persist) {
      await upsertContractFacts(address, { facts, codeHash: fingerprint.codeHash, implementation: fingerprint.implementation, implementationCodeHash: facts.implementationCodeHash, owner: fingerprint.owner }).catch((err) =>
        console.warn(`⚠️  Contract Check: couldn't cache facts for ${address}:`, err.message)
      );
    }
    remember(address, facts, fingerprint);
    return facts;
  })().finally(() => inFlight.delete(address));
  inFlight.set(address, job);
  return job;
}
