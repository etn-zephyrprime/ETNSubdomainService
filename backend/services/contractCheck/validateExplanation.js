// Checks a Claude explanation against the facts it was given, in code — the model's own promise to stay on
// the facts isn't relied on. Returns the problems found (empty = valid).
//   - every address (full, or shortened like 0x1234…abcd) must be one that appears in the facts
//   - every number must appear in the facts (or the display block's rounded figures); small counts (<= 10) are fine
//   - `overall`, when present, must equal the computed facts.overall
//   - no "safe" / "scam" verdicts, no buy/sell advice (wording rule)
import { factsForPrompt } from "./prompts.js";

const BANNED = [
  { re: /\bsafe\b/i, why: 'says "safe"' },
  { re: /\bscam\b/i, why: 'says "scam"' },
  { re: /\b(you should|we recommend|i recommend)\b[^.]{0,40}\b(buy|sell|hold|invest)\b/i, why: "gives financial advice" },
];

/** Every string anywhere in a value. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** What the facts allow an explanation to cite: their addresses, the text their numbers are checked
 * against, and the names it may quote (a token can be called "SafeMoon" — quoting that isn't a verdict). */
export function allowedFromFacts(facts) {
  const text = JSON.stringify(factsForPrompt(facts)).toLowerCase();
  const addresses = new Set(text.match(/0x[0-9a-f]{40}/g) || []);
  const names = [
    facts.identity?.contractName,
    facts.identity?.etnName,
    facts.identity?.known?.label,
    facts.identity?.deployerKnown?.label,
    facts.token?.name,
    facts.token?.symbol,
    facts.proxy?.implementationName,
    facts.proxy?.adminName,
    facts.ownership?.ownerEtnName,
    facts.creation?.deployerEtnName,
    ...(facts.token?.topHolders || []).map((h) => h.name),
  ].filter((x) => typeof x === "string" && x.trim().length > 1);
  return { text: text.replace(/,/g, ""), addresses, names: [...new Set(names)].sort((a, b) => b.length - a.length) };
}

/** `s` with the facts' own names blanked out (longest first, exactly as written — case-sensitive, so a token
 * whose symbol is "SAFE" can be quoted while "it is safe" is still caught), so the wording rule judges only
 * what the explanation says, not what a contract happens to be called. */
function withoutQuotedNames(s, names) {
  let out = s;
  for (const n of names) out = out.split(n).join(" ");
  return out;
}

export function validateExplanation(output, facts, { allowed = allowedFromFacts(facts) } = {}) {
  const problems = [];
  if (output == null || typeof output !== "object") return ["not a JSON object"];
  if ("overall" in output && output.overall !== facts.overall) problems.push(`overall is "${output.overall}" but the facts say "${facts.overall}"`);
  for (const s of strings(output)) {
    const own = withoutQuotedNames(s, allowed.names || []);
    for (const b of BANNED) if (b.re.test(own)) problems.push(`${b.why}: "${s.slice(0, 80)}"`);
    // full addresses
    for (const a of s.match(/0x[0-9a-fA-F]{40}/g) || []) if (!allowed.addresses.has(a.toLowerCase())) problems.push(`address ${a} isn't in the facts`);
    // shortened addresses (0x1234…abcd / 0x1234...abcd) must match the start and end of a fact address
    for (const m of s.matchAll(/0x([0-9a-fA-F]{3,8})(?:…|\.\.\.)([0-9a-fA-F]{3,8})/g)) {
      const [pre, post] = [m[1].toLowerCase(), m[2].toLowerCase()];
      if (![...allowed.addresses].some((a) => a.slice(2).startsWith(pre) && a.endsWith(post))) problems.push(`address ${m[0]} doesn't match one in the facts`);
    }
    // numbers (not inside hex, identifiers or addresses)
    const noAddr = s.replace(/0x[0-9a-fA-F]+(?:(?:…|\.\.\.)[0-9a-fA-F]+)?/g, " ");
    for (const m of noAddr.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g)) {
      const n = m[0].replace(/,/g, "");
      if (Number(n) <= 10 && !n.includes(".")) continue;
      if (!allowed.text.includes(n)) problems.push(`number ${m[0]} isn't in the facts`);
    }
  }
  return [...new Set(problems)];
}
