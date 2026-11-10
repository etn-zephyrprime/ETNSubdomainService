// Privileged powers — which state-changing functions a contract exposes, grouped into the categories a
// holder cares about, and whether each is gated to an owner/admin. Pure: reads the verified ABI and source
// only. A power is reported only when a function with a matching name is in the ABI; gating comes from
// the source (a modifier like onlyOwner / onlyRole, or a msg.sender / _checkOwner check at the top of the
// body) — "unknown" when the function's body isn't in the published source. Never inferred beyond that.
//
// Each gated power also says WHO it's gated to (`gate`): "owner" (onlyOwner / owner() checks, including a
// custom modifier whose body checks the owner), "role" (AccessControl), or "custom" — a role of the
// contract's own, like CORE's onlyTaxWallet (require(msg.sender == taxWallet)). A custom role outlives a
// renounced owner, so riskFlags.js treats it as live unless the role's address reads as zero. `controller`
// names the state variable holding it when the source shows one, so fetchContractData can read it.
//
// balanceOverwrite isn't matched by name: it's any public function whose body sets a balance outright
// (_balances[param] = …, not += / -=) for an address it's given — e.g. CORE's transferTaxWallet, which
// replaces the new address's balance instead of adding to it.

export const POWER_CATEGORIES = {
  mint: /^_?mint|^mintTo$|^issue$/i,
  pause: /^(pause|unpause|setPaused|togglePause|pauseTrading|unpauseTrading)$|^(enable|disable|start|stop|open|close)Trading$|^setTrading(Enabled|Active|Open)?$/i,
  blacklist: /(black|block|deny|ban)list|blacklist|freeze|^(set|add|remove)?Bots?$|^setBlocked|^block(Address|Account|Wallet)s?$/i,
  // fee/tax RATE setters (setBuyFee, setSellTax, setFees, setTaxPercent) — not who's exempt (setTaxExemption) —
  // and switches that turn the tax off and on (toggleTaxesPaused, enableFees)
  fees: /^(set|update|change)\w*(fee|fees|tax|taxes)(rate|rates|percent|percentage|bps|amount)?$|^(toggle|pause|unpause|enable|disable)\w*(fee|fees|tax|taxes)\w*$/i,
  routerPair: /^(set|update|change)\w*(router|pair)\w*$/i,
  withdraw: /(withdraw|rescue|sweep|recover|clearStuck|salvage)/i,
  upgrade: /^(upgradeTo|upgradeToAndCall|upgrade|changeAdmin|setImplementation)$/i,
};
const SOURCE_CATEGORIES = ["balanceOverwrite"]; // found from the function body, not its name

// Standard plumbing that isn't a "power" over holders (ownership/role management is reported separately).
const IGNORED = new Set(["transfer", "transferFrom", "approve", "increaseAllowance", "decreaseAllowance", "permit", "transferOwnership", "renounceOwnership", "acceptOwnership", "grantRole", "revokeRole", "renounceRole", "multicall", "safeTransferFrom", "setApprovalForAll"]);

const GATE_MODIFIER = /\bonly[A-Z_]\w*\b|\bauth\b|\bonlyRole\s*\(/;
const GATE_BODY = /require\s*\(\s*(_?msgSender\s*\(\s*\)|msg\.sender)\s*==|_checkOwner\s*\(|_checkRole\s*\(|hasRole\s*\(|_onlyOwner\s*\(|if\s*\(\s*(_?msgSender\s*\(\s*\)|msg\.sender)\s*!=/;

// The identifier msg.sender is compared with: require(msg.sender == X) / if (msg.sender != X()) / X == msg.sender
const SENDER_CMP = /(?:_?msgSender\s*\(\s*\)|msg\.sender)\s*[=!]=\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)(?:\s*\(\s*\))?\s*[=!]=\s*(?:_?msgSender\s*\(\s*\)|msg\.sender)/;
const OWNER_CHECK = /_checkOwner\s*\(|_onlyOwner\s*\(/;
const ROLE_CHECK = /_checkRole\s*\(|hasRole\s*\(/;
const OWNER_NAMES = /^_?owner$|^getOwner$/i;
const BALANCE_SET = /\b_?balances?\s*\[\s*([A-Za-z_]\w*)\s*\]\s*=(?!=)/gi;

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

const publicDefs = (files, name) => findDefinitions(files, name).filter((d) => !d.isDeclaration && !/\b(internal|private)\b/.test(d.header));
const isGated = (d) => GATE_MODIFIER.test(d.header) || GATE_BODY.test(d.body);

/** true (gated), false (callable by anyone), or "unknown" (no body in the published source). */
export function gatingFromSource(files, name) {
  const defs = publicDefs(files, name);
  if (!defs.length) return "unknown";
  return defs.some(isGated);
}

/** Who a gate check (a modifier's or function's body) restricts to: { gate, controller } or null. */
function gateFromCode(code) {
  if (OWNER_CHECK.test(code)) return { gate: "owner", controller: null };
  if (ROLE_CHECK.test(code)) return { gate: "role", controller: null };
  const m = code.match(SENDER_CMP);
  if (!m) return null;
  const id = m[1] || m[2];
  if (OWNER_NAMES.test(id)) return { gate: "owner", controller: null };
  return { gate: "custom", controller: id };
}

/** A modifier's body from the sources (first definition), or null. */
function modifierBody(files, name) {
  const re = new RegExp(`modifier\\s+${name}\\b[^{;]*\\{`);
  for (const text of files) {
    const m = re.exec(text);
    if (m) return text.slice(m.index + m[0].length, m.index + m[0].length + 600);
  }
  return null;
}

/** For a gated definition: { gate: "owner" | "role" | "custom", controller, modifier } (best effort; an
 * unrecognised check counts as a custom role, never as the owner). */
function gateDetails(files, def) {
  const mod = (def.header.match(/\bonly[A-Za-z_]\w*\b|\bauth\b/) || [])[0];
  if (mod === "onlyOwner") return { gate: "owner", controller: null, modifier: mod };
  if (mod === "onlyRole") return { gate: "role", controller: null, modifier: mod };
  if (mod) {
    const body = modifierBody(files, mod);
    const g = body ? gateFromCode(body) : null;
    return { gate: g?.gate || "custom", controller: g?.controller || null, modifier: mod };
  }
  const g = gateFromCode(def.body.slice(0, 300));
  return { gate: g?.gate || "custom", controller: g?.controller || null, modifier: null };
}

/** Whether a function takes an arbitrary token address (so it can move any token the contract holds). */
function takesTokenAddress(fn) {
  return (fn.inputs || []).some((i) => i.type === "address" && /token|asset|erc20|currency/i.test(i.name || "")) || /token|erc20/i.test(fn.name);
}

/** One power entry: whether it's gated, and to whom. */
function powerEntry(files, fn, signature, defs) {
  const base = { name: fn.name, signature, takesTokenAddress: takesTokenAddress(fn) };
  if (!defs?.length) return { ...base, gated: "unknown", gate: null, controller: null };
  const gatedDef = defs.find(isGated);
  if (!gatedDef) return { ...base, gated: false, gate: null, controller: null };
  const { gate, controller, modifier } = gateDetails(files, gatedDef);
  return { ...base, gated: true, gate, controller, ...(modifier ? { modifier } : {}) };
}

/**
 * Scans an ABI (and source, if published) for privileged powers.
 * Returns `{ analysedFrom: "source"|"abi"|"none", byCategory: { [category]: [{ name, signature, gated, gate,
 * controller, takesTokenAddress }] }, customControllers: [variable names] }`.
 */
export function findPrivilegedPowers(abi, contract) {
  const byCategory = Object.fromEntries([...Object.keys(POWER_CATEGORIES), ...SOURCE_CATEGORIES].map((k) => [k, []]));
  if (!Array.isArray(abi) || !abi.length) return { analysedFrom: "none", byCategory, customControllers: [] };
  const files = sourceFiles(contract);
  const seen = new Set();
  for (const fn of abi) {
    if (fn?.type !== "function" || fn.stateMutability === "view" || fn.stateMutability === "pure") continue;
    if (IGNORED.has(fn.name)) continue;
    const signature = `${fn.name}(${(fn.inputs || []).map((i) => i.type).join(",")})`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const defs = files.length ? publicDefs(files, fn.name) : [];
    const category = Object.keys(POWER_CATEGORIES).find((c) => POWER_CATEGORIES[c].test(fn.name)); // first match wins
    if (category) byCategory[category].push(powerEntry(files, fn, signature, defs));

    const params = new Set((fn.inputs || []).filter((i) => i.type === "address" && i.name).map((i) => i.name));
    const overwritten = defs.flatMap((d) => [...d.body.matchAll(BALANCE_SET)].map((m) => m[1]).filter((p) => params.has(p)));
    if (overwritten.length) byCategory.balanceOverwrite.push({ ...powerEntry(files, fn, signature, defs), param: overwritten[0] });
  }
  const customControllers = [...new Set(Object.values(byCategory).flat().filter((p) => p.gate === "custom" && p.controller).map((p) => p.controller))];
  return { analysedFrom: files.length ? "source" : "abi", byCategory, customControllers };
}
