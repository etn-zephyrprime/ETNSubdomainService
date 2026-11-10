// Contract Check phase 4 — pure pieces for Telegram: reading an approval out of an explorer transaction,
// deciding whether a new approval is worth a DM, and the message text for /check, approval alerts and
// watchlist changes. Telegram legacy Markdown; every name that comes from a contract (or a token, or a
// user) is escaped with md(), since contract names are attacker-controlled text.
import { DISCLAIMER } from "./prompts.js";

export const md = (s) => String(s ?? "").replace(/([_*`\[])/g, "\\$1");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The approval a wallet's own transaction granted (or revoked), from Blockscout's decoded input:
 * { token, spender, kind: "amount" | "all", tokenId, revoke, txHash, block } — or null if it isn't one.
 * approve(spender, amount) / increaseAllowance(spender, added) / approve(to, tokenId) (NFT) /
 * setApprovalForAll(operator, approved). Amount 0, approved=false or an NFT approval to 0x0 is a revoke.
 */
export function approvalFromTx(t, walletKey) {
  if (!t || t.status !== "ok" || t.from?.hash?.toLowerCase() !== walletKey || !t.to?.hash) return null;
  const method = t.decoded_input?.method_call || "";
  const params = t.decoded_input?.parameters || [];
  const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
  const token = t.to.hash.toLowerCase();
  const base = { token, txHash: t.hash || null, block: t.block_number ?? t.block ?? null };
  if (/^(approve|increaseAllowance)\(/.test(method)) {
    const spender = String(p.spender || p.to || p.operator || params[0]?.value || "").toLowerCase();
    if (!isAddr(spender)) return null;
    const amount = p.amount ?? p.value ?? p.wad ?? p.addedValue ?? p.tokenId ?? params[1]?.value ?? null;
    const revoke = spender === ZERO || (amount != null && /^0+$/.test(String(amount)));
    return { ...base, spender, kind: "amount", tokenId: p.tokenId ?? p.amount ?? p.value ?? null, revoke };
  }
  if (/^setApprovalForAll\(/.test(method)) {
    const operator = String(p.operator || params[0]?.value || "").toLowerCase();
    if (!isAddr(operator)) return null;
    const approved = p.approved ?? params[1]?.value;
    return { ...base, spender: operator, kind: "all", tokenId: null, revoke: approved === false || String(approved) === "false" };
  }
  return null;
}

/**
 * Why a new approval deserves a DM (empty = it doesn't): the spender isn't a contract at all, isn't in our
 * registry and none of the member's wallets has used it before, or its Contract Check has caution/high flags.
 */
export function approvalAlertReasons({ isContract, known, usedBefore, overall }) {
  const reasons = [];
  if (isContract === false) reasons.push("notContract");
  else if (!known && !usedBefore) reasons.push("neverUsed");
  if (overall === "red" || overall === "amber") reasons.push(overall === "red" ? "highFlags" : "cautionFlags");
  return reasons;
}

const OVERALL = { green: "🟢 No caution flags", amber: "🟡 Caution", red: "🔴 High risk flags" };
const SEV = { high: "🔴", caution: "🟡", info: "ℹ️" };

/** A compact contract card for /check. */
export function formatCheckCard({ facts, oneLiner = null, link, alternatives = [] }) {
  const name = facts.identity?.known?.label || (facts.token?.symbol ? `${facts.token.symbol}${facts.identity?.contractName ? ` — ${facts.identity.contractName}` : ""}` : facts.identity?.contractName) || short(facts.address);
  if (facts.identity?.isContract === false) return `🔎 *${md(short(facts.address))}* is a wallet, not a contract — there's no code to check.`;
  const v = facts.verification?.status;
  const verification = v === "verified" ? "Verified source" : v === "verifiedTwin" ? "Code matches a verified contract" : v === "unverified" ? "Source not published" : "Verification unknown";
  const age = facts.creation?.ageDays != null ? `${Math.floor(facts.creation.ageDays)} days old` : null;
  const lines = [
    `🛡️ *${md(name)}*`,
    `\`${facts.address}\``,
    `${OVERALL[facts.overall] || "Not checked yet"}${facts.identity?.known ? " · Known contract" : ""}`,
    [verification, facts.proxy?.isProxy ? "upgradeable proxy" : null, age].filter(Boolean).join(" · "),
  ];
  const flags = (facts.riskFlags || []).filter((f) => f.severity !== "info");
  const info = (facts.riskFlags || []).filter((f) => f.severity === "info");
  if (flags.length || info.length) {
    lines.push("");
    for (const f of [...flags, ...info].slice(0, 8)) lines.push(`${SEV[f.severity] || "•"} ${md(f.fact)}`);
  } else lines.push("", "No risk flags raised from the facts we could check.");
  if (v === "unverified") lines.push("", "_Source code isn't published, so we can only see limited signals._");
  if (oneLiner) lines.push("", md(oneLiner));
  lines.push("", `[Open the full card](${link})`);
  if (alternatives.length) lines.push(`Other matches: ${alternatives.map((a) => md(a)).join(", ")}`);
  lines.push(`_${md(DISCLAIMER)}_`);
  return lines.join("\n");
}

/** "Your wallet approved spending on a contract you've never used before" + why + a link to its card. */
export function formatApprovalAlert({ walletName, tokenLabel, spenderName, spender, reasons, overall, kind, link }) {
  const what = kind === "all" ? `all your ${md(tokenLabel)}` : md(tokenLabel);
  const head = reasons.includes("notContract")
    ? `⚠️ *${md(walletName)} approved a wallet address — not a contract — to spend ${what}.*`
    : reasons.includes("neverUsed")
      ? `⚠️ *Your wallet ${md(walletName)} approved spending on a contract you've never used before.*`
      : `⚠️ *Your wallet ${md(walletName)} approved spending on a contract with ${overall === "red" ? "high risk" : "caution"} flags.*`;
  const lines = [head, "", `Token: ${what}`, `Spender: ${md(spenderName || short(spender))}`, `\`${spender}\``];
  if (overall && OVERALL[overall]) lines.push(`Contract Check: ${OVERALL[overall]}`);
  lines.push("", "If you didn't mean to, revoke it from Core Tier → Contract Check → Approvals.", `[Open its card](${link})`, "", "_Send /contractalerts off to stop these._");
  return lines.join("\n");
}

const FIELD = { owner: "Owner", implementation: "Implementation (its code was upgraded)", codeHash: "Code" };

/** A watchlist change on a token the member holds. */
export function formatChangeAlert({ label, address, changes, link }) {
  const lines = [`🔔 *${md(label || short(address))} changed*`, `\`${address}\``, "", "A token you hold was changed on-chain:"];
  for (const c of changes) {
    if (c.field === "owner" && c.to === ZERO) lines.push(`• Ownership renounced (was ${md(short(c.from))})`);
    else if (c.field === "codeHash") lines.push(`• ${FIELD.codeHash} changed`);
    else lines.push(`• ${FIELD[c.field] || md(c.field)}: ${md(short(c.from) || "none")} → ${md(short(c.to) || "none")}`);
  }
  lines.push("", `[Open its card](${link})`, "", "_Send /contractalerts off to stop these._");
  return lines.join("\n");
}
