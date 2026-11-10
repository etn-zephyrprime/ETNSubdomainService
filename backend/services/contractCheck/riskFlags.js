// Rule-based risk flags from ContractFacts (thresholds and severities: riskRules.config.js). Pure, and
// facts-only: each flag carries the fact that triggered it. Deliberately never reads facts.identity.known
// — a known/registry contract is labelled, not excused.
import { RISK_RULES, RISK_THRESHOLDS, LIQUIDITY_LOCK_NOT_APPLICABLE, SEVERITY_CAPS } from "./riskRules.config.js";

const SEVERITY_RANK = { info: 0, caution: 1, high: 2 };

/** Whether someone can still use a gated power. A renounced Ownable owner makes owner-gated functions
 * dead; a custom role (e.g. onlyTaxWallet) is dead only when its address reads as zero — it doesn't go away
 * with the owner; AccessControl roles count as active. A power whose gate couldn't be told apart falls back
 * to the owner: a contract with no owner() can still gate through its own admin storage, so that's active. */
function controllerActive(f, p) {
  if (p?.gate === "custom") return f.ownership.customRoles?.find((r) => r.name === p.controller)?.status !== "renounced";
  if (p?.gate === "role") return true;
  const o = f.ownership;
  return !(o.pattern === "ownable" && o.ownerStatus === "renounced");
}

/** The main pool's lock facts when the lock rules apply: a listed, non-dust token whose locks were read,
 * and not one where locking doesn't apply (LIQUIDITY_LOCK_NOT_APPLICABLE). Otherwise null (no flag). */
function lockCheck(f) {
  const l = f.liquidity;
  if (l?.status !== "listed" || !l.mainPool || LIQUIDITY_LOCK_NOT_APPLICABLE[f.address] || !(l.usd >= RISK_THRESHOLDS.minLiquidityUsdForLockCheck)) return null;
  return l.mainPool;
}

/** Whether a main pool that isn't 50% locked is instead mostly farmed by many farmers — locked + farmed reach
 * the threshold and no single farmer holds more than maxSingleFarmerPct of the pool. */
const farmedEnough = (m) => m.farmedPct > 0 && m.lockedPct + m.farmedPct >= RISK_THRESHOLDS.mainPoolMinLockedPct && m.largestFarmerPct <= RISK_THRESHOLDS.maxSingleFarmerPct;

/** Powers in a category that someone can still use: gated (or gating not visible) to a live controller —
 * never ones anyone can call (those aren't a power over holders, except balanceOverwrite below). */
const gatedPowers = (f, category) => (f.powers.byCategory[category] || []).filter((p) => p.gated !== false && controllerActive(f, p));
const roleOf = (p) => (p.gate === "custom" ? p.controller || p.modifier || "a separate role" : null);
const names = (list) => list.map((p) => (roleOf(p) ? `${p.name} — ${roleOf(p)} role` : p.name)).join(", ");

const RULES = {
  unverified_source: (f) => (f.verification.status === "unverified" ? "Source code isn't published (unverified on the explorer)" : null),
  verified_by_twin: (f) =>
    f.verification.status === "verifiedTwin" ? `Not verified at this address, but its code is identical to the verified contract ${f.verification.twinAddress}, whose published source was analysed` : null,
  upgradeable_eoa_admin: (f) => {
    const p = f.proxy;
    if (!p.isProxy) return null;
    if (p.upgradeController?.type === "eoa") return `Upgradeable proxy: upgrades are controlled by a single wallet (${p.upgradeController.address})`;
    return null;
  },
  upgradeable_proxy: (f) => {
    const p = f.proxy;
    if (!p.isProxy || p.upgradeController?.type === "eoa") return null;
    return `Upgradeable proxy: its code can be replaced${p.upgradeController?.address ? ` by ${p.upgradeController.address} (a contract)` : ""}`;
  },
  owner_can_mint: (f) => {
    const list = gatedPowers(f, "mint");
    return list.length ? `Owner/admin can mint new tokens (${names(list)})` : null;
  },
  blacklist_power: (f) => {
    const list = gatedPowers(f, "blacklist");
    return list.length ? `Owner/admin can block or freeze addresses (${names(list)})` : null;
  },
  owner_adjustable_fees: (f) => {
    const list = gatedPowers(f, "fees");
    return list.length ? `Owner/admin can change fees or taxes (${names(list)})` : null;
  },
  pause_power: (f) => {
    const list = gatedPowers(f, "pause");
    return list.length ? `Owner/admin can pause transfers or trading (${names(list)})` : null;
  },
  router_pair_changeable: (f) => {
    const list = gatedPowers(f, "routerPair");
    return list.length ? `Owner/admin can change the router or pair it trades through (${names(list)})` : null;
  },
  owner_can_sweep_tokens: (f) => {
    const list = gatedPowers(f, "withdraw").filter((p) => p.takesTokenAddress);
    return list.length ? `Owner/admin can withdraw any token the contract holds (${names(list)})` : null;
  },
  young_contract: (f) => {
    const d = f.creation.ageDays;
    return d != null && d < RISK_THRESHOLDS.youngContractDays ? `Deployed ${d < 1 ? "less than a day" : `${Math.floor(d)} day(s)`} ago` : null;
  },
  concentrated_holders: (f) => {
    const pct = f.token?.top10PctExcludingBurn;
    return pct != null && pct > RISK_THRESHOLDS.top10ConcentrationPct
      ? `Top 10 holders hold ${pct.toFixed(1)}% of the supply (${RISK_THRESHOLDS.excludePoolsFromConcentration ? "burn addresses and liquidity pools" : "burn addresses"} left out)`
      : null;
  },
  balance_overwrite: (f) => {
    const all = f.powers.byCategory.balanceOverwrite || [];
    const open = all.filter((p) => p.gated === false);
    if (open.length) return `Anyone can call ${names(open)}, which sets an address's token balance outright instead of adding to it`;
    const list = all.filter((p) => p.gated !== false && controllerActive(f, p));
    return list.length ? `A privileged role can overwrite any address's token balance (${names(list)}: sets the balance of the address it's given instead of adding to it)` : null;
  },
  custom_role_control: (f) => {
    const live = (f.ownership.customRoles || []).filter((r) => r.status !== "renounced");
    if (!live.length) return null;
    const fns = (r) => [...new Set(Object.values(f.powers.byCategory).flat().filter((p) => p.gate === "custom" && p.controller === r.name).map((p) => p.name))].join(", ");
    return live.map((r) => `Functions restricted to ${r.name} (${r.holder || "holder not readable"}), a role separate from the owner: ${fns(r)}`).join("; ");
  },
  liquidity_unlocked: (f) => {
    const m = lockCheck(f);
    if (!m || m.lockedPct >= RISK_THRESHOLDS.mainPoolMinLockedPct || farmedEnough(m)) return null;
    const expired = m.expiredPct > 0 ? `; a lock on ${m.expiredPct}% of it has expired, so its owner can withdraw that at any time` : "";
    return `${m.lockedPct === 0 ? "None" : `Only ${m.lockedPct}%`} of the liquidity in its main ElectroSwap pool (${m.address}, holding ${m.sharePct}% of its pooled tokens) is locked${expired}`;
  },
  liquidity_farmed: (f) => {
    const m = lockCheck(f);
    if (!m || m.lockedPct >= RISK_THRESHOLDS.mainPoolMinLockedPct || !farmedEnough(m)) return null;
    return `${m.farmedPct}% of the liquidity in its main ElectroSwap pool (${m.address}, holding ${m.sharePct}% of its pooled tokens) is staked in the ElectroSwap yield farm by ${m.farmerCount} farmers; it isn't locked, and each can withdraw their own share at any time (the largest holds ${m.largestFarmerPct}% of the pool)${m.lockedPct > 0 ? `; ${m.lockedPct}% is locked` : ""}`;
  },
  liquidity_partly_locked: (f) => {
    const m = lockCheck(f);
    if (!m || m.lockedPct < RISK_THRESHOLDS.mainPoolMinLockedPct || f.liquidity.lockedPctOverall >= RISK_THRESHOLDS.overallMinLockedPct) return null;
    return `Its main ElectroSwap pool is ${m.lockedPct}% locked, but across all its pools only ${f.liquidity.lockedPctOverall}% of the pooled tokens are in locked liquidity`;
  },
  liquidity_lock_expiring: (f) => {
    const m = lockCheck(f);
    if (!m || m.lockedPct < RISK_THRESHOLDS.mainPoolMinLockedPct || m.lockedPctIn30Days >= RISK_THRESHOLDS.mainPoolMinLockedPct) return null;
    return `A lock on its main ElectroSwap pool ends on ${m.nextUnlockAt.slice(0, 10)}; after that only ${m.lockedPctIn30Days}% of that pool would stay locked`;
  },
  owner_renounced: (f) => (f.ownership.ownerStatus === "renounced" ? "Ownership has been renounced (owner is the zero address)" : null),
};

/** `[{ id, severity, fact }]`, highest severity first. */
export function computeRiskFlags(facts, rules = RISK_RULES, caps = SEVERITY_CAPS) {
  const flags = [];
  const cap = caps[facts.address];
  for (const [id, rule] of Object.entries(rules)) {
    if (!rule?.enabled || !RULES[id]) continue;
    const fact = RULES[id](facts);
    if (!fact) continue;
    if (cap && SEVERITY_RANK[rule.severity] > SEVERITY_RANK[cap]) flags.push({ id, severity: cap, fact, cappedFrom: rule.severity });
    else flags.push({ id, severity: rule.severity, fact });
  }
  return flags.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** "red" | "amber" | "green" — the highest severity among the flags (high -> red, caution -> amber). */
export function overallFromFlags(flags) {
  const top = Math.max(-1, ...flags.map((f) => SEVERITY_RANK[f.severity] ?? -1));
  return top >= 2 ? "red" : top === 1 ? "amber" : "green";
}
