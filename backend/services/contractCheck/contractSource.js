// The published source the explanation layer quotes from — the same code the powers were scanned from
// (the implementation for a proxy, the verified twin's source for an unverified-but-identical contract).
// Never bytecode: an unverified contract has no source here, and explain.js says so instead of guessing.
import { fetchBlockscoutJsonOrNull } from "../../utils/blockscoutClient.js";
import { sourceFiles } from "./privilegedPowers.js";

const MEMO_MS = 60 * 60 * 1000;
const memo = new Map(); // address -> { files, at }
// ~25k tokens of source at most; past that, privileged functions first (see sourceForPrompt).
export const MAX_SOURCE_CHARS = Number(process.env.CONTRACT_SOURCE_MAX_CHARS) || 100000;

/** The address whose published source backs these facts, or null when there's none. */
export function sourceAddressFor(facts) {
  if (facts.proxy?.isProxy) return ["verified", "verifiedTwin"].includes(facts.proxy.implementationVerified) ? facts.proxy.implementation : null;
  return ["verified", "verifiedTwin"].includes(facts.verification?.status) ? facts.address : null;
}

/** `[{ path, text }]` for the facts' source address (cached for an hour), or [] when there's no source. */
export async function getSourceFiles(facts) {
  const addr = sourceAddressFor(facts);
  if (!addr) return [];
  const m = memo.get(addr);
  if (m && Date.now() - m.at < MEMO_MS) return m.files;
  const sc = await fetchBlockscoutJsonOrNull(`/smart-contracts/${addr}`);
  const texts = sourceFiles(sc);
  const paths = [sc?.file_path || "main.sol", ...(sc?.additional_sources || []).filter((f) => f?.source_code).map((f) => f.file_path || "source.sol")];
  const files = texts.map((text, i) => ({ path: paths[i] || `source${i}.sol`, text }));
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  memo.set(addr, { files, at: Date.now() });
  return files;
}

/** Each definition of `name`, from `function name(` to its closing brace (best effort). */
function extractFunction(text, name) {
  const out = [];
  const re = new RegExp(`function\\s+${name.replace(/[^\w$]/g, "")}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf("{", m.index);
    const semi = text.indexOf(";", m.index);
    if (open < 0 || (semi >= 0 && semi < open)) continue;
    let depth = 0, i = open;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

/**
 * The source text for the prompt: everything when it fits; otherwise every privileged function's
 * definition first, then as much of the rest (main file first) as fits — marked as truncated.
 * Returns `{ text, truncated }`.
 */
export function sourceForPrompt(files, facts, maxChars = MAX_SOURCE_CHARS) {
  if (!files.length) return { text: "", truncated: false };
  const whole = files.map((f) => `// ==== ${f.path} ====\n${f.text}`).join("\n\n");
  if (whole.length <= maxChars) return { text: whole, truncated: false };
  const names = [...new Set(Object.values(facts.powers?.byCategory || {}).flat().map((p) => p.name))];
  const parts = ["// ==== Privileged functions (extracted) ===="];
  for (const name of names) for (const f of files) for (const def of extractFunction(f.text, name)) parts.push(`// from ${f.path}\n${def}`);
  let text = parts.join("\n\n");
  const rest = `\n\n// ==== Rest of the source (truncated to fit) ====\n${whole}`;
  text += rest.slice(0, Math.max(0, maxChars - text.length));
  return { text: text.slice(0, maxChars) + "\n// [source truncated]", truncated: true };
}
