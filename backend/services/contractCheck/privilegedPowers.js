// Privileged powers — which state-changing functions a contract exposes, grouped into the categories a
// holder cares about, and whether each is gated to an owner/admin. Pure: reads the verified ABI and source
// only. A power is reported only when a function with a matching name is in the ABI; gating comes from
// the source (a modifier like onlyOwner / onlyRole, or a msg.sender / _checkOwner check at the top of the
// body) — "unknown" when the function's body isn't in the published source. Never inferred beyond that.

export const POWER_CATEGORIES = {
  mint: /^_?mint|^mintTo$|^issue$/i,
  pause: /^(pause|unpause|setPaused|togglePause|pauseTrading|unpauseTrading)$|^(enable|disable|start|stop|open|close)Trading$|^setTrading(Enabled|Active|Open)?$/i,
  blacklist: /(black|block|deny|ban)list|blacklist|freeze|^(set|add|remove)?Bots?$|^setBlocked|^block(Address|Account|Wallet)s?$/i,
  // fee/tax RATE setters (setBuyFee, setSellTax, setFees, setTaxPercent) — not who's exempt (setTaxExemption)
  fees: /^(set|update|change)\w*(fee|fees|tax|taxes)(rate|rates|percent|percentage|bps|amount)?$/i,
  routerPair: /^(set|update|change)\w*(router|pair)\w*$/i,
  withdraw: /(withdraw|rescue|sweep|recover|clearStuck|salvage)/i,
  upgrade: /^(upgradeTo|upgradeToAndCall|upgrade|changeAdmin|setImplementation)$/i,
};

// Standard plumbing that isn't a "power" over holders (ownership/role management is reported separately).
const IGNORED = new Set(["transfer", "transferFrom", "approve", "increaseAllowance", "decreaseAllowance", "permit", "transferOwnership", "renounceOwnership", "acceptOwnership", "grantRole", "revokeRole", "renounceRole", "multicall", "safeTransferFrom", "setApprovalForAll"]);

const GATE_MODIFIER = /\bonly[A-Z_]\w*\b|\bauth\b|\bonlyRole\s*\(/;
const GATE_BODY = /require\s*\(\s*(_?msgSender\s*\(\s*\)|msg\.sender)\s*==|_checkOwner\s*\(|_checkRole\s*\(|hasRole\s*\(|_onlyOwner\s*\(|if\s*\(\s*(_?msgSender\s*\(\s*\)|msg\.sender)\s*!=/;

/** Every published source file's text: Blockscout's main file plus its additional sources. */
export function sourceFiles(contract) {
  if (!contract) return [];
  const files = [];
  if (contract.source_code) files.push(contract.source_code);
  for (const f of contract.additional_sources || []) if (f?.source_code) files.push(f.source_code);
  return files;
}

/** The function's header (signature through modifiers) and the first part of its body, for each
 * definition of `name` in the sources. */
function findDefinitions(files, name) {
  const defs = [];
  const re = new RegExp(`function\\s+${name.replace(/[^\w$]/g, "")}\\s*\\(`, "g");
  for (const text of files) {
    let m;
    while ((m = re.exec(text))) {
      // walk to the matching ')' of the parameter list, then to the body '{' (or ';' for a declaration)
      let i = m.index + m[0].length, depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      const rest = text.slice(i, i + 2000);
      const end = rest.search(/[{;]/);
      if (end < 0) continue;
      const header = rest.slice(0, end);
      const body = rest[end] === "{" ? rest.slice(end + 1, end + 600) : "";
      defs.push({ header, body, isDeclaration: rest[end] === ";" });
    }
  }
  return defs;
}

/** true (gated), false (callable by anyone), or "unknown" (no body in the published source). */
export function gatingFromSource(files, name) {
  const defs = findDefinitions(files, name).filter((d) => !d.isDeclaration && !/\b(internal|private)\b/.test(d.header));
  if (!defs.length) return "unknown";
  if (defs.some((d) => GATE_MODIFIER.test(d.header) || GATE_BODY.test(d.body))) return true;
  return false;
}

/** Whether a function takes an arbitrary token address (so it can move any token the contract holds). */
function takesTokenAddress(fn) {
  return (fn.inputs || []).some((i) => i.type === "address" && /token|asset|erc20|currency/i.test(i.name || "")) || /token|erc20/i.test(fn.name);
}

/**
 * Scans an ABI (and source, if published) for privileged powers.
 * Returns `{ analysedFrom: "source"|"abi"|"none", byCategory: { [category]: [{ name, signature, gated, takesTokenAddress }] } }`.
 */
export function findPrivilegedPowers(abi, contract) {
  const byCategory = Object.fromEntries(Object.keys(POWER_CATEGORIES).map((k) => [k, []]));
  if (!Array.isArray(abi) || !abi.length) return { analysedFrom: "none", byCategory };
  const files = sourceFiles(contract);
  const seen = new Set();
  for (const fn of abi) {
    if (fn?.type !== "function" || fn.stateMutability === "view" || fn.stateMutability === "pure") continue;
    if (IGNORED.has(fn.name)) continue;
    const signature = `${fn.name}(${(fn.inputs || []).map((i) => i.type).join(",")})`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    for (const [category, re] of Object.entries(POWER_CATEGORIES)) {
      if (!re.test(fn.name)) continue;
      byCategory[category].push({ name: fn.name, signature, gated: files.length ? gatingFromSource(files, fn.name) : "unknown", takesTokenAddress: takesTokenAddress(fn) });
      break; // one category per function — the first match, in POWER_CATEGORIES order
    }
  }
  return { analysedFrom: files.length ? "source" : "abi", byCategory };
}
