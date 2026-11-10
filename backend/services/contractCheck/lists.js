// Contract Check list views: the contracts a member's wallets have used, a wallet's active approvals,
// and search suggestions. Rows carry only what a list shows (label, badge); the full card comes from
// analyseContract when one is opened. Contracts without cached facts are analysed in the background, a
// few at a time, so their badges fill in on a later visit without a burst of explorer/RPC calls now.
import { ethers } from "ethers";
import { getTouchedAddresses, getFactsSummaries, getKnownContracts, searchKnownContracts } from "../../db/contractCheckLists.js";
import { getCoveredWallets } from "../../db/trackedWallets.js";
import { fetchBlockscoutJson, fetchBlockscoutJsonOrNull } from "../../utils/blockscoutClient.js";
import { resolveEtnName } from "../../utils/primaryNameResolver.js";
import { analyseContract } from "./analyseContract.js";
import { contractCheckProvider } from "./fetchContractData.js";
import { KNOWN_CONTRACTS_SEED } from "./knownContracts.js";

const MAX_UINT = ethers.MaxUint256;
const UNLIMITED_AT = 2n ** 255n; // anything this large is an "unlimited" approval in practice

// ---- background analysis queue (one at a time, deduped) ------------------------------------------
const queue = [];
const queued = new Set();
let draining = false;
export function queueAnalysis(addresses, max = 5) {
  for (const a of addresses.slice(0, max)) {
    const k = a.toLowerCase();
    if (queued.has(k)) continue;
    queued.add(k);
    queue.push(k);
  }
  if (draining) return;
  draining = true;
  (async () => {
    while (queue.length) {
      const a = queue.shift();
      await analyseContract(a).catch(() => null);
      queued.delete(a);
    }
    draining = false;
  })();
}

const seedByAddress = new Map(KNOWN_CONTRACTS_SEED.map((k) => [k.address.toLowerCase(), k]));
async function labelsFor(addresses) {
  const db = await getKnownContracts(addresses).catch(() => ({}));
  return Object.fromEntries(addresses.map((a) => [a, db[a] || (seedByAddress.get(a) ? { label: seedByAddress.get(a).label, project: seedByAddress.get(a).project, category: seedByAddress.get(a).category, verifiedByUs: seedByAddress.get(a).verifiedByUs } : null)]));
}

// Whether an address holds code — contract-ness doesn't change, so it's remembered for the process.
const isContractMemo = new Map();
async function isContract(address) {
  if (isContractMemo.has(address)) return isContractMemo.get(address);
  const code = await contractCheckProvider().getCode(address).catch(() => null);
  if (code == null) return null;
  const yes = code !== "0x";
  if (isContractMemo.size > 20000) isContractMemo.clear();
  isContractMemo.set(address, yes);
  return yes;
}

/**
 * The contracts a member's wallets (their own + tracked) have interacted with, unknown ones first, then
 * by most recent interaction. Rows: `{ address, lastAt, kinds, known, name, symbol, overall }`
 * (overall null = not checked yet — queued for analysis).
 */
export async function usedContracts(ownerWallet, { limit = 150 } = {}) {
  const wallets = (await getCoveredWallets(ownerWallet)).map((w) => w.address.toLowerCase());
  const touched = await getTouchedAddresses(wallets, 300);
  // Tokens, DeFi contracts and pools are contracts by definition; a plain counterparty may be a wallet.
  const rows = [];
  for (const t of touched) {
    if (rows.length >= limit) break;
    const sure = t.kinds.some((k) => k !== "counterparty");
    if (!sure && !(await isContract(t.address))) continue;
    rows.push(t);
  }
  const addrs = rows.map((r) => r.address);
  const [labels, facts] = await Promise.all([labelsFor(addrs), getFactsSummaries(addrs).catch(() => ({}))]);
  const out = rows.map((r) => ({ ...r, known: labels[r.address] || null, name: facts[r.address]?.name || null, symbol: facts[r.address]?.symbol || null, overall: facts[r.address]?.overall || null }));
  queueAnalysis(out.filter((r) => !r.overall).map((r) => r.address));
  // unknown contracts first (the ones worth a look), then most recent
  return out.sort((a, b) => (a.known ? 1 : 0) - (b.known ? 1 : 0) || new Date(b.lastAt) - new Date(a.lastAt));
}

// ---- approvals -------------------------------------------------------------------------------------
const APPROVAL_ABI = new ethers.Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);
async function view(to, fn, args) {
  try {
    const data = await contractCheckProvider().call({ to, data: APPROVAL_ABI.encodeFunctionData(fn, args) });
    if (!data || data === "0x") return undefined;
    return APPROVAL_ABI.decodeFunctionResult(fn, data)[0];
  } catch (err) {
    if (err?.code === "CALL_EXCEPTION" || err?.code === "BAD_DATA") return undefined;
    throw err;
  }
}

// Token name/symbol/decimals rarely change — fetched once per token per process.
const tokenMetaMemo = new Map();
async function tokenMeta(token) {
  if (tokenMetaMemo.has(token)) return tokenMetaMemo.get(token);
  const tk = await fetchBlockscoutJsonOrNull(`/tokens/${token}`).catch(() => undefined);
  if (tk === undefined) return null; // explorer hiccup: don't remember it
  if (tokenMetaMemo.size > 5000) tokenMetaMemo.clear();
  tokenMetaMemo.set(token, tk);
  return tk;
}

const approvalsMemo = new Map(); // wallet -> { at, value }
const APPROVALS_MEMO_MS = 5 * 60 * 1000;
const MAX_TX_PAGES = Number(process.env.CONTRACT_CHECK_APPROVAL_TX_PAGES) || 40; // 50 txs a page

/**
 * A wallet's approvals that are still live: ERC-20 allowances and NFT operator approvals it granted with
 * approve / increaseAllowance / setApprovalForAll (found in its own transactions, then checked live).
 * Approvals granted by signature (permit) don't appear as the wallet's own transactions and aren't listed.
 * Returns `{ approvals: [{ token, tokenName, tokenSymbol, spender, kind, allowance, unlimited, spenderKnown, spenderOverall }], scannedTxs, complete }`.
 */
export async function activeApprovals(walletInput, { force = false } = {}) {
  const wallet = ethers.getAddress(walletInput);
  const key = wallet.toLowerCase();
  const m = approvalsMemo.get(key);
  if (!force && m && Date.now() - m.at < APPROVALS_MEMO_MS) return m.value;

  // 1. Every approval the wallet granted, newest first, from its own transactions.
  const granted = new Map(); // token|spender|kind -> { token, spender, kind, tokenId }
  let params = "", pages = 0, scannedTxs = 0, complete = true;
  for (;;) {
    const page = await fetchBlockscoutJson(`/addresses/${wallet}/transactions${params ? `?${params}` : ""}`);
    for (const t of page.items || []) {
      scannedTxs++;
      if (t.status !== "ok" || t.from?.hash?.toLowerCase() !== key || !t.to?.hash) continue;
      const method = t.decoded_input?.method_call || "";
      const p = Object.fromEntries((t.decoded_input?.parameters || []).map((x) => [x.name, x.value]));
      const token = t.to.hash.toLowerCase();
      if (/^(approve|increaseAllowance)\(/.test(method)) {
        const spender = String(p.spender || p.to || p.operator || Object.values(p)[0] || "").toLowerCase();
        if (ethers.isAddress(spender)) granted.set(`${token}|${spender}|amount`, { token, spender, kind: "amount", tokenId: p.tokenId ?? p.amount ?? p.value ?? null });
      } else if (/^setApprovalForAll\(/.test(method)) {
        const operator = String(p.operator || Object.values(p)[0] || "").toLowerCase();
        if (ethers.isAddress(operator) && !granted.has(`${token}|${operator}|all`)) granted.set(`${token}|${operator}|all`, { token, spender: operator, kind: "all" });
      }
    }
    pages++;
    if (!page.next_page_params) break;
    if (pages >= MAX_TX_PAGES) {
      complete = false;
      break;
    }
    params = new URLSearchParams(page.next_page_params).toString();
  }

  // 2. Which are still live (one call at a time — Electroneum's RPC rejects big batches).
  const approvals = [];
  for (const g of granted.values()) {
    if (g.kind === "all") {
      if ((await view(g.token, "isApprovedForAll", [wallet, g.spender])) === true) approvals.push({ token: g.token, spender: g.spender, kind: "nft-all", allowance: null, unlimited: true });
      continue;
    }
    const allowance = await view(g.token, "allowance", [wallet, g.spender]);
    if (allowance !== undefined) {
      if (allowance > 0n) approvals.push({ token: g.token, spender: g.spender, kind: "erc20", allowance: allowance.toString(), unlimited: allowance >= UNLIMITED_AT || allowance === MAX_UINT });
    } else if (g.tokenId != null) {
      // ERC-721 approve(to, tokenId) shares ERC-20's approve signature; a single-token NFT approval.
      const approved = await view(g.token, "getApproved", [BigInt(g.tokenId)]).catch(() => undefined);
      if (approved && String(approved).toLowerCase() === g.spender) approvals.push({ token: g.token, spender: g.spender, kind: "nft-one", tokenId: String(g.tokenId), allowance: null, unlimited: false });
    }
  }

  // 3. Labels: token name/symbol (once per token), registry labels, the spender's cached badge.
  const spenders = [...new Set(approvals.map((a) => a.spender))];
  const tokens = [...new Set(approvals.map((a) => a.token))];
  const [labels, facts, tokenLabels] = await Promise.all([labelsFor(spenders), getFactsSummaries(spenders).catch(() => ({})), labelsFor(tokens)]);
  for (const a of approvals) {
    const tk = await tokenMeta(a.token);
    a.tokenName = tk?.name || tokenLabels[a.token]?.label || null;
    a.tokenSymbol = tk?.symbol || null;
    a.tokenDecimals = tk?.decimals != null ? Number(tk.decimals) : null;
    a.tokenKnown = tokenLabels[a.token] || null;
    a.spenderKnown = labels[a.spender] || null;
    a.spenderName = facts[a.spender]?.name || null;
    a.spenderOverall = facts[a.spender]?.overall || null;
  }
  queueAnalysis(spenders.filter((s) => !facts[s]?.overall));
  const value = { approvals, scannedTxs, complete };
  approvalsMemo.set(key, { at: Date.now(), value });
  return value;
}

/** Forget a wallet's cached approvals (after it revokes one). */
export const forgetApprovals = (wallet) => approvalsMemo.delete(String(wallet).toLowerCase());

// ---- search ----------------------------------------------------------------------------------------
/**
 * Suggestions for the search box: a pasted address, a resolving name.etn, registry matches (label or
 * project), and the explorer's own token/contract search. `[{ address, label, sub, kind }]`, at most 8.
 */
export async function searchContracts(qInput) {
  const q = String(qInput || "").trim().slice(0, 80);
  if (q.length < 2) return [];
  const out = new Map();
  const add = (address, label, sub, kind) => {
    const a = address.toLowerCase();
    if (!out.has(a) && out.size < 8) out.set(a, { address: a, label, sub, kind });
  };
  if (ethers.isAddress(q)) add(q, "Address", q, "address");
  if (q.toLowerCase().endsWith(".etn")) {
    const a = await resolveEtnName(contractCheckProvider(), q);
    if (a) add(a, q.toLowerCase(), a, "name");
  }
  const ql = q.toLowerCase();
  const reg = await searchKnownContracts(q).catch(() => []);
  for (const r of reg.length ? reg : KNOWN_CONTRACTS_SEED.filter((k) => k.label.toLowerCase().includes(ql) || (k.project || "").toLowerCase().includes(ql))) add(r.address, r.label, r.project || r.category, "known");
  const bs = await fetchBlockscoutJsonOrNull(`/search?q=${encodeURIComponent(q)}`).catch(() => null);
  for (const i of bs?.items || []) {
    if (!i.address || !["token", "contract"].includes(i.type)) continue;
    add(i.address, i.symbol ? `${i.name || i.symbol} (${i.symbol})` : i.name || "Contract", i.type === "token" ? `${i.token_type || "token"}` : "contract", i.type);
  }
  return [...out.values()];
}
