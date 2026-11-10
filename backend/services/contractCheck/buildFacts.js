// ContractFacts from the raw data fetchContractData.js gathered. Pure — every field comes from that data,
// and anything a source couldn't tell us stays null / "unknown" (never a guess): a Blockscout outage must
// read as "couldn't check", not "unverified" (which would raise a flag). Risk flags and the overall colour
// are computed here too (riskFlags.js), so the explanation layer only ever words them.
import { findPrivilegedPowers } from "./privilegedPowers.js";
import { computeRiskFlags, overallFromFlags } from "./riskFlags.js";
import { RISK_THRESHOLDS } from "./riskRules.config.js";

export const FACTS_SCHEMA_VERSION = 3; // 2: custom roles (gate/controller on powers, ownership.customRoles), balanceOverwrite; 3: liquidity + LP locks, severity caps
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);
const lc = (a) => (a ? String(a).toLowerCase() : null);
const POOL_LOCKERS = new Set(["0x16ca736c8b181772009e598f37f137e9cd36afae"]); // ElectroSwap Liquidity Locker
/** A holder that's a liquidity pool / locker — by the explorer's own contract label, never a guess. */
const isPool = (h) => h.isContract && (POOL_LOCKERS.has(h.address) || /\b(LP|Pair|Pool)\b|-LP\b|LP Token/i.test(h.name || ""));

const pct1 = (x) => Math.round(x * 1000) / 10; // 0..1 -> percent, 1 decimal

/** ElectroSwap liquidity and how much of it is locked (tokens only). status: "listed" | "notListed" |
 * "unknown" (cache unreadable). pools = poolLocks.js's per-pool reads (absent if they failed): each pool's
 * sharePct of the token's pooled supply, lockedPct / expiredPct of that pool's liquidity, and its locks. */
function liquidityFacts(l, now) {
  if (l === undefined) return { status: "unknown" };
  if (l === null) return { status: "notListed" };
  const out = { status: "listed", usd: Math.round(l.usd), poolCount: l.poolCount, locksRead: Array.isArray(l.pools) };
  if (!Array.isArray(l.pools) || !l.pools.length) return out;
  const total = l.pools.reduce((s, p) => s + BigInt(p.tokenAmount), 0n);
  const shareOf = (p) => (total > 0n ? Number((BigInt(p.tokenAmount) * 1000000n) / total) / 1000000 : 0);
  const soon = now + 30 * 86400000;
  out.pools = l.pools.map((p) => {
    const endingSoon = p.locks.filter((k) => k.unlockAt && Date.parse(k.unlockAt) <= soon).reduce((s, k) => s + k.share, 0);
    const nextUnlockAt = p.locks.map((k) => k.unlockAt).filter(Boolean).sort()[0] || null;
    return { address: p.address, version: p.version, sharePct: pct1(shareOf(p)), lockedPct: pct1(p.lockedShare), expiredPct: pct1(p.expiredShare), lockedPctIn30Days: pct1(Math.max(0, p.lockedShare - endingSoon)), nextUnlockAt, permanent: p.locks.some((k) => !k.unlockAt) };
  });
  out.mainPool = out.pools[0];
  out.lockedPctOverall = pct1(l.pools.reduce((s, p) => s + shareOf(p) * p.lockedShare, 0));
  return out;
}

/** "verified" | "verifiedTwin" (unverified here, but identical bytecode to a verified contract — Blockscout's
 * verified twin) | "unverified" | "notContract" | "unknown" (the explorer couldn't be asked). */
function verificationStatus(info, contract) {
  if (!info) return "unknown";
  if (!info.is_contract) return "notContract";
  if (info.is_verified) return "verified";
  return contract?.verified_twin_address_hash && contract?.source_code ? "verifiedTwin" : "unverified";
}

/** A contract owner's kind, from its verified ABI/name: multisig (Safe-style), timelock, ProxyAdmin, other. */
function contractKind(c) {
  if (!c) return "unverified";
  const fns = new Set((c.abi || []).filter((x) => x.type === "function").map((x) => x.name));
  if (fns.has("getThreshold") && fns.has("getOwners")) return "multisig";
  if (fns.has("getMinDelay")) return "timelock";
  if (/proxyadmin/i.test(c.name || "")) return "proxyAdmin";
  return "other";
}

/** Percent of `total` (BigInt) that `value` (BigInt) is, to 4 decimal places. */
const pctOf = (value, total) => (total > 0n ? Number((value * 1000000n) / total) / 10000 : null);

function tokenFacts(raw, deployer, owner) {
  const t = raw.token;
  if (!t) return null;
  let total = null;
  try {
    total = BigInt(t.total_supply);
  } catch {
    total = null;
  }
  const holders = Array.isArray(raw.holders) ? raw.holders : null;
  const top = holders
    ? holders.map((h) => {
        let v = 0n;
        try {
          v = BigInt(h.value);
        } catch {
          v = 0n;
        }
        return { address: lc(h.address?.hash), value: v, isContract: Boolean(h.address?.is_contract), name: h.address?.name || null };
      })
    : null;
  const sum = (list) => list.reduce((s, h) => s + h.value, 0n);
  const top10 = top ? top.slice(0, 10) : null;
  // Concentration leaves out burn addresses and (RISK_THRESHOLDS.excludePoolsFromConcentration) liquidity
  // pools — liquidity in a pool isn't a whale. Which holders were left out is recorded alongside.
  const left = (h) => BURN.has(h.address) || (RISK_THRESHOLDS.excludePoolsFromConcentration && isPool(h));
  const top10NoBurn = top ? top.filter((h) => !left(h)).slice(0, 10) : null;
  const excluded = top ? top.slice(0, 10).filter(left).map((h) => ({ address: h.address, name: h.name, pct: total ? pctOf(h.value, total) : null, reason: BURN.has(h.address) ? "burn" : POOL_LOCKERS.has(h.address) ? "liquidity locker" : "liquidity pool" })) : null;
  const pctIn = (addr) => (top && addr ? (top.find((h) => h.address === lc(addr)) ? pctOf(top.find((h) => h.address === lc(addr)).value, total) : null) : null);
  return {
    name: t.name || null,
    symbol: t.symbol || null,
    type: t.type || null,
    decimals: t.decimals != null ? Number(t.decimals) : null,
    totalSupply: t.total_supply ?? null,
    holderCount: t.holders != null ? Number(t.holders) : null,
    top10Pct: top10 && total ? pctOf(sum(top10), total) : null,
    top10PctExcludingBurn: top10NoBurn && total ? pctOf(sum(top10NoBurn), total) : null, // burn (and pools, per config) left out
    concentrationExcluded: excluded,
    topHolders: top10 ? top10.map((h) => ({ address: h.address, pct: total ? pctOf(h.value, total) : null, isContract: h.isContract, name: h.name, isBurn: BURN.has(h.address) })) : null,
    // null = not in the top page of holders Blockscout returned (or no holders data), not "0%"
    deployerHolderPct: pctIn(deployer),
    ownerHolderPct: owner && owner !== ZERO ? pctIn(owner) : null,
  };
}

/** @param raw see fetchContractData.js. @returns ContractFacts */
export function buildFacts(raw) {
  const info = raw.addressInfo || null;
  const names = raw.names || {};
  const nameOf = (a) => (a ? names[lc(a)] || null : null);
  const contract = raw.contract || null;
  const status = verificationStatus(info, contract);
  const impl = raw.implementation || null;

  // Proxy: the EIP-1967 implementation slot is authoritative; Blockscout's proxy fields are the fallback.
  const implAddress = lc(raw.slots?.implementation) || lc(contract?.implementations?.[0]?.address) || null;
  const isProxy = Boolean(implAddress);
  const target = isProxy ? impl?.contract || null : contract; // whose code the powers come from
  const abi = target?.abi || null;
  const powers = findPrivilegedPowers(abi, target);

  // Ownership — read live from the (proxy) address, so it reflects what the contract would actually check.
  const own = raw.ownership || {};
  let pattern, ownerStatus;
  if (own.failed) {
    pattern = "unknown";
    ownerStatus = "unknown";
  } else if (own.owner !== undefined && own.owner !== null) {
    pattern = "ownable";
    ownerStatus = lc(own.owner) === ZERO ? "renounced" : own.ownerIsContract ? "contract" : "eoa";
  } else if (own.accessControl?.present) {
    pattern = "accessControl";
    ownerStatus = "none";
  } else {
    pattern = "none";
    ownerStatus = "none";
  }
  const ownership = {
    pattern,
    owner: own.owner ? lc(own.owner) : null,
    ownerSource: own.source || null,
    ownerStatus,
    ownerEtnName: nameOf(own.owner),
    ownerContract: own.ownerIsContract ? { name: own.ownerContract?.name || null, verified: Boolean(own.ownerContract), kind: contractKind(own.ownerContract) } : null,
    adminRoleHolders: own.accessControl?.adminHolders ? own.accessControl.adminHolders.map(lc) : null,
    deployerHasAdminRole: own.accessControl?.deployerIsAdmin ?? null,
    // Roles of the contract's own that gate powers (e.g. CORE's taxWallet) — they outlive a renounced owner.
    // holder null = couldn't read it (no getter, or the call failed): treated as live.
    customRoles: powers.customControllers.map((name) => {
      const holder = raw.roleHolders && name in raw.roleHolders ? lc(raw.roleHolders[name]) : null;
      return { name, holder, status: holder === null ? "unknown" : holder === ZERO ? "renounced" : "active", holderEtnName: nameOf(holder) };
    }),
  };

  // Who can upgrade a proxy: the admin slot (Transparent: an EOA, or a ProxyAdmin contract whose owner
  // decides), else (UUPS) the implementation's owner if it exposes an upgrade function.
  let upgradeController = null;
  if (isProxy) {
    const a = raw.admin;
    if (a?.address) {
      if (a.isContract && a.owner && lc(a.owner) !== ZERO) upgradeController = { type: a.ownerIsContract ? "contract" : "eoa", address: lc(a.owner), via: lc(a.address) };
      else if (a.isContract) upgradeController = { type: "contract", address: lc(a.address), via: null };
      else upgradeController = { type: "eoa", address: lc(a.address), via: null };
    } else if (powers.byCategory.upgrade.length && ownership.owner && ownerStatus !== "renounced") {
      upgradeController = { type: ownerStatus === "contract" ? "contract" : "eoa", address: ownership.owner, via: "owner (UUPS)" };
    } else {
      upgradeController = { type: "unknown", address: null, via: null };
    }
  }
  const proxy = {
    isProxy,
    standard: isProxy ? (raw.slots?.implementation ? "eip1967" : contract?.proxy_type || "unknown") : null,
    implementation: implAddress,
    implementationName: impl?.contract?.name || contract?.implementations?.[0]?.name || null,
    implementationVerified: isProxy ? verificationStatus(impl?.addressInfo, impl?.contract) : null,
    admin: lc(raw.admin?.address) || null,
    adminName: raw.admin?.contractName || null,
    adminEtnName: nameOf(raw.admin?.address),
    upgradeController,
  };

  const deployer = lc(info?.creator_address_hash) || null;
  const createdMs = raw.creationTx?.timestamp ? Date.parse(raw.creationTx.timestamp) : null;
  const facts = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    address: lc(raw.address),
    chainId: 52014,
    analysedAt: new Date(raw.now ?? Date.now()).toISOString(),
    incomplete: (raw.unavailable || []).length > 0,
    unavailable: raw.unavailable || [],
    identity: {
      isContract: status === "notContract" ? false : info ? true : raw.codeHash ? true : null,
      contractName: contract?.name || info?.name || null,
      etnName: nameOf(raw.address) || info?.ens_domain_name || null,
      known: raw.known || null,
      deployerKnown: raw.deployerKnown || null, // e.g. ElectroSwap's V2 factory for every V2 pair — a label only
    },
    verification: {
      status,
      twinAddress: status === "verifiedTwin" ? lc(contract.verified_twin_address_hash) : null,
      compilerVersion: contract?.compiler_version || null,
      language: contract?.language || null,
      verifiedAt: contract?.verified_at || null,
    },
    proxy,
    ownership,
    powers,
    creation: {
      txHash: info?.creation_transaction_hash || null,
      timestamp: raw.creationTx?.timestamp || null,
      ageDays: createdMs ? Math.max(0, ((raw.now ?? Date.now()) - createdMs) / 86400000) : null,
      deployer,
      deployerEtnName: nameOf(deployer),
    },
    token: tokenFacts(raw, deployer, ownership.owner),
    activity: {
      txCount: raw.counters?.transactions_count != null ? Number(raw.counters.transactions_count) : null,
      lastActivityAt: raw.lastActivityAt || null,
    },
    liquidity: liquidityFacts(raw.liquidity, raw.now ?? Date.now()),
    codeHash: raw.codeHash || null,
    implementationCodeHash: impl?.codeHash || null,
  };
  facts.riskFlags = facts.identity.isContract === false ? [] : computeRiskFlags(facts);
  facts.overall = overallFromFlags(facts.riskFlags);
  return facts;
}
