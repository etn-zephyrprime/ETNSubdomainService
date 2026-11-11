// Owner-action watch: a token's owner (or a role of its own, like CORE's taxWallet, or an AccessControl
// admin) USING its powers — raising a tax, pausing, blacklisting, minting — changes neither the code nor the
// owner, so the fingerprint diff never sees it. This finds those calls in the controllers' own transactions
// (one explorer page per controller per run), for the functions Contract Check already lists as that
// contract's privileged powers. Pure helpers here; the fetching and delivery live in contractAlertScheduler.
//
// A controller that is itself a contract calls the token from inside calls made TO it: a Safe multisig's
// execTransaction(to, value, data, …) and an OpenZeppelin TimelockController's schedule / execute (and their
// batch forms). routedActionsFromTxs reads those from the controller's own explorer transactions, decoding
// the raw input (so it works even when the explorer can't decode it) and matching the wrapped call's 4-byte
// selector against the token's privileged functions. A timelock's schedule is reported too — the early
// warning, with its delay — before the execute. A Safe that owns a timelock that owns the token (two hops)
// isn't followed.
import { ethers } from "ethers";

const ROUTERS = new ethers.Interface([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
]);

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

/** selector (0x + 8 hex) -> function name, for the token's privileged functions that someone can call. */
export function selectorsOf(facts) {
  const out = new Map();
  for (const list of Object.values(facts?.powers?.byCategory || {})) for (const p of list) if (p.gated !== false && p.signature) out.set(ethers.id(p.signature).slice(0, 10), p.name);
  return out;
}

/**
 * Privileged calls a multisig or timelock `controller` made on `token`, from calls TO the controller:
 * [{ fn, by, via: "multisig" | "timelock", stage: "executed" | "scheduled", delaySec, txHash, block, args }].
 */
export function routedActionsFromTxs(txs, { token, controller, selectors, afterBlock }) {
  const t0 = token.toLowerCase();
  const c0 = controller.toLowerCase();
  const out = [];
  for (const t of txs || []) {
    const block = Number(t?.block_number ?? t?.block ?? 0);
    if (t?.status !== "ok" || t.to?.hash?.toLowerCase() !== c0 || block <= afterBlock || !t.raw_input) continue;
    let call;
    try {
      call = ROUTERS.parseTransaction({ data: t.raw_input });
    } catch {
      continue; // not a multisig / timelock call
    }
    if (!call) continue;
    const name = call.name;
    const inner =
      name === "execTransaction" ? [[call.args.to, call.args.data]]
        : name === "schedule" ? [[call.args.target, call.args.data]]
          : name === "execute" ? [[call.args.target, call.args.payload]]
            : call.args.targets.map((x, i) => [x, call.args.payloads[i]]);
    for (const [target, data] of inner) {
      if (String(target).toLowerCase() !== t0) continue;
      const fn = selectors.get(String(data).slice(0, 10).toLowerCase());
      if (!fn) continue;
      out.push({
        fn,
        by: c0,
        via: name === "execTransaction" ? "multisig" : "timelock",
        stage: name.startsWith("schedule") ? "scheduled" : "executed",
        delaySec: name.startsWith("schedule") ? Number(call.args.delay) : null,
        txHash: t.hash,
        block,
        args: "",
      });
    }
  }
  return out.sort((a, b) => a.block - b.block);
}
