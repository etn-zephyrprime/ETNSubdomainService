// Rule-based risk flags from ContractFacts (thresholds and severities: riskRules.config.js). Pure, and
// facts-only: each flag carries the fact that triggered it. Deliberately never reads facts.identity.known
// — a known/registry contract is labelled, not excused.
import { RISK_RULES, RISK_THRESHOLDS } from "./riskRules.config.js";

const SEVERITY_RANK = { info: 0, caution: 1, high: 2 };

/** Whether someone can still use a gated power. Only a renounced Ownable owner (with no role-based
 * control) makes owner-gated functions dead; a contract with no owner() can still gate through its own
 * admin storage (e.g. an onlyMinter modifier), so that counts as active. */
function controllerActive(f) {
  const o = f.ownership;
  return !(o.pattern === "ownable" && o.ownerStatus === "renounced");
}

/** Powers in a category that an owner/admin can use: gated (or gating not visible) — never ones anyone can call. */
const gatedPowers = (f, category) => (f.powers.byCategory[category] || []).filter((p) => p.gated !== false);
const names = (list) => list.map((p) => p.name).join(", ");

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
    return list.length && controllerActive(f) ? `Owner/admin can mint new tokens (${names(list)})` : null;
  },
  blacklist_power: (f) => {
    const list = gatedPowers(f, "blacklist");
    return list.length && controllerActive(f) ? `Owner/admin can block or freeze addresses (${names(list)})` : null;
  },
  owner_adjustable_fees: (f) => {
    const list = gatedPowers(f, "fees");
    return list.length && controllerActive(f) ? `Owner/admin can change fees or taxes (${names(list)})` : null;
  },
  pause_power: (f) => {
    const list = gatedPowers(f, "pause");
    return list.length && controllerActive(f) ? `Owner/admin can pause transfers or trading (${names(list)})` : null;
  },
  router_pair_changeable: (f) => {
    const list = gatedPowers(f, "routerPair");
    return list.length && controllerActive(f) ? `Owner/admin can change the router or pair it trades through (${names(list)})` : null;
  },
  owner_can_sweep_tokens: (f) => {
    const list = gatedPowers(f, "withdraw").filter((p) => p.takesTokenAddress);
    return list.length && controllerActive(f) ? `Owner/admin can withdraw any token the contract holds (${names(list)})` : null;
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
  owner_renounced: (f) => (f.ownership.ownerStatus === "renounced" ? "Ownership has been renounced (owner is the zero address)" : null),
};

/** `[{ id, severity, fact }]`, highest severity first. */
export function computeRiskFlags(facts, rules = RISK_RULES) {
  const flags = [];
  for (const [id, rule] of Object.entries(rules)) {
    if (!rule?.enabled || !RULES[id]) continue;
    const fact = RULES[id](facts);
    if (fact) flags.push({ id, severity: rule.severity, fact });
  }
  return flags.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** "red" | "amber" | "green" — the highest severity among the flags (high -> red, caution -> amber). */
export function overallFromFlags(flags) {
  const top = Math.max(-1, ...flags.map((f) => SEVERITY_RANK[f.severity] ?? -1));
  return top >= 2 ? "red" : top === 1 ? "amber" : "green";
}
