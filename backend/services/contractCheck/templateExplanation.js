// The fallback explanation: the same shape as Claude's summary, built from ContractFacts alone — used when
// Claude isn't configured, refuses, or fails validation twice. Plain and factual; passes
// validateExplanation like any other answer.
import { LIMITED_SIGNALS_NOTICE } from "./prompts.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "an unknown address");
const who = (addr, name) => (name ? `${name} (${short(addr)})` : short(addr));
const flag = (f, id) => f.riskFlags.find((x) => x.id === id)?.fact || null;
const sourceUnavailable = (f) => !["verified", "verifiedTwin"].includes(f.verification.status);
const OVERALL_WORDS = {
  red: "Red: at least one high-severity flag — read the flags below before interacting.",
  amber: "Amber: there are caution flags worth reading before interacting.",
  green: "Green: no caution or high-severity flags were raised from the facts we could check.",
};

function describe(f) {
  const name = f.identity.known?.label || f.identity.contractName || "This contract";
  if (f.identity.isContract === false) return `${short(f.address)} is a wallet address, not a contract.`;
  if (f.token?.type) return `${name} is an ${f.token.type} token${f.token.symbol ? ` (${f.token.symbol})` : ""}${f.proxy.isProxy ? " behind an upgradeable proxy" : ""}.`;
  if (f.proxy.isProxy) return `${name} is an upgradeable proxy contract${f.proxy.implementationName ? ` running ${f.proxy.implementationName}` : ""}.`;
  if (f.identity.deployerKnown) return `${name} is a contract deployed by ${f.identity.deployerKnown.label}.`;
  return `${name} is a smart contract.`;
}

function controller(f) {
  const o = f.ownership;
  if (o.ownerStatus === "renounced") return "Nobody: ownership was renounced (the owner is the zero address), so owner-only functions can no longer be used.";
  if (o.ownerStatus === "eoa") return `A single wallet, ${who(o.owner, o.ownerEtnName)}, is the owner.`;
  if (o.ownerStatus === "contract") return `A contract, ${short(o.owner)}${o.ownerContract?.kind && o.ownerContract.kind !== "other" ? ` (${o.ownerContract.kind})` : ""}, is the owner.`;
  if (o.pattern === "accessControl") return `It uses admin roles${o.adminRoleHolders?.length ? ` held by ${o.adminRoleHolders.map((a) => short(a)).join(", ")}` : ""}.`;
  if (o.ownerStatus === "unknown") return "We couldn't read who controls it right now.";
  return "It has no owner function; no single owner was found.";
}

/** `{ oneLiner, ownerPowers, chipAnswers, overall, overallSummary }` from the facts alone. */
export function templateSummary(f) {
  const powers = f.riskFlags.filter((x) => ["owner_can_mint", "blacklist_power", "owner_adjustable_fees", "pause_power", "router_pair_changeable", "owner_can_sweep_tokens", "upgradeable_eoa_admin", "upgradeable_proxy", "balance_overwrite", "custom_role_control"].includes(x.id)).map((x) => x.fact);
  const none = sourceUnavailable(f) ? LIMITED_SIGNALS_NOTICE : "No owner or admin powers over holders were found in the published source.";
  const upgrade = f.proxy.isProxy
    ? flag(f, "upgradeable_eoa_admin") || flag(f, "upgradeable_proxy") || "Yes — it's an upgradeable proxy, so its code can be replaced."
    : sourceUnavailable(f)
      ? `Not as a standard proxy. ${LIMITED_SIGNALS_NOTICE}`
      : "No — it isn't an upgradeable proxy.";
  return {
    oneLiner: describe(f),
    ownerPowers: powers,
    chipAnswers: {
      whatDoesItDo: describe(f) + (sourceUnavailable(f) ? ` ${LIMITED_SIGNALS_NOTICE}` : ""),
      canOwnerTakeTokens: flag(f, "owner_can_sweep_tokens") || (sourceUnavailable(f) ? LIMITED_SIGNALS_NOTICE : "No owner function that moves arbitrary tokens out of the contract was found."),
      canChangeFees: flag(f, "owner_adjustable_fees") || (sourceUnavailable(f) ? LIMITED_SIGNALS_NOTICE : "No owner-adjustable fee or tax rate was found."),
      canPauseOrFreeze: [flag(f, "pause_power"), flag(f, "blacklist_power")].filter(Boolean).join(" ") || (sourceUnavailable(f) ? LIMITED_SIGNALS_NOTICE : "No pause, freeze or blocklist function an owner can use was found."),
      isUpgradeable: upgrade,
      whoControlsIt: controller(f),
    },
    overall: f.overall,
    overallSummary: OVERALL_WORDS[f.overall],
    ...(powers.length ? {} : { ownerPowersNote: none }),
  };
}

/** The fallback for a free-text question: no answer we could check, plus where to look. */
export function templateAnswer(f) {
  return {
    answer: `We couldn't produce a checked answer to that question right now. ${f.riskFlags.length ? `What the facts show: ${f.riskFlags.map((x) => x.fact).join(" ")}` : "The facts raised no flags."}`,
    answerable: false,
  };
}
