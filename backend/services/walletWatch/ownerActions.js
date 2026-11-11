// Owner-action watch: a token's owner (or a role of its own, like CORE's taxWallet, or an AccessControl
// admin) USING its powers — raising a tax, pausing, blacklisting, minting — changes neither the code nor the
// owner, so the fingerprint diff never sees it. This finds those calls in the controllers' own transactions
// (one explorer page per controller per run), for the functions Contract Check already lists as that
// contract's privileged powers. Pure helpers here; the fetching and delivery live in contractAlertScheduler.
//
// A controller that is itself a contract (a multisig or timelock) calls the token from inside its own
// transactions, which aren't the controller's "transactions" on the explorer — those calls aren't seen here.

const ZERO = "0x0000000000000000000000000000000000000000";

/** Names of the token's privileged functions that someone can call (gated, or gating unknown). */
export function privilegedNames(facts) {
  const names = new Set();
  for (const list of Object.values(facts?.powers?.byCategory || {})) for (const p of list) if (p.gated !== false) names.add(p.name);
  return names;
}

/** Who can call them: the owner (unless renounced), live custom-role holders, AccessControl admins. */
export function controllersOf(facts) {
  const out = new Set();
  const o = facts?.ownership || {};
  if (o.owner && o.owner !== ZERO && o.ownerStatus !== "renounced") out.add(o.owner.toLowerCase());
  for (const r of o.customRoles || []) if (r.holder && r.status === "active") out.add(r.holder.toLowerCase());
  for (const a of o.adminRoleHolders || []) if (a && a !== ZERO) out.add(a.toLowerCase());
  return [...out];
}

const argText = (params) =>
  (params || [])
    .slice(0, 4)
    .map((p) => {
      const v = String(p.value ?? "");
      return `${p.name || "arg"}=${v.length > 20 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v}`;
    })
    .join(", ");

/**
 * Privileged calls in a controller's transactions: [{ fn, by, txHash, block, args }], oldest first.
 * Only successful calls straight to `token`, to one of `names`, in blocks after `afterBlock`.
 */
export function ownerActionsFromTxs(txs, { token, by, names, afterBlock }) {
  const t0 = token.toLowerCase();
  return (txs || [])
    .filter((t) => t?.status === "ok" && t.to?.hash?.toLowerCase() === t0 && t.from?.hash?.toLowerCase() === by && Number(t.block_number ?? t.block ?? 0) > afterBlock)
    .map((t) => ({ fn: (t.decoded_input?.method_call || t.method || "").split("(")[0], by, txHash: t.hash, block: Number(t.block_number ?? t.block ?? 0), args: argText(t.decoded_input?.parameters) }))
    .filter((a) => a.fn && names.has(a.fn))
    .sort((a, b) => a.block - b.block);
}
