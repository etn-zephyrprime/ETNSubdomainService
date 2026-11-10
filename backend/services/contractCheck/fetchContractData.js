// Gathers the raw data buildFacts.js turns into ContractFacts. Blockscout first (fetchBlockscoutJsonOrNull:
// a 404 is an answer, e.g. "no verified source"); RPC only for what Blockscout can't give — the EIP-1967
// slots, code hashes and live view calls (owner(), AccessControl). Everything runs one call at a time on a
// non-batching provider (no Promise.all bursts — Electroneum's RPC rejects big batches). A source that
// fails is named in `unavailable` and its field left undefined, so buildFacts reports "unknown" rather
// than a wrong answer.
import { ethers } from "ethers";
import { fetchBlockscoutJsonOrNull } from "../../utils/blockscoutClient.js";
import { createRpcProvider } from "../../utils/rpcProvider.js";
import { createPrimaryNameResolver, shortAddress } from "../../utils/primaryNameResolver.js";
import { lookupKnownContract } from "./knownContracts.js";
import { findPrivilegedPowers } from "./privilegedPowers.js";
import { getTokenLiquidityCache } from "../../state/tokenLiquidityState.js";
import { getTokenLocksCache } from "../../state/tokenLocksState.js";

export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

const VIEW_ABI = new ethers.Interface([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
]);

let sharedProvider = null;
export function contractCheckProvider() {
  if (!sharedProvider) sharedProvider = createRpcProvider({ batchMaxCount: 1 });
  return sharedProvider;
}

const slotAddress = (word) => {
  if (!word || /^0x0*$/.test(word)) return null;
  const a = ethers.getAddress(ethers.dataSlice(word, 12));
  return a === ethers.ZeroAddress ? null : a;
};

/** A view call: its decoded result, `undefined` when the function isn't there (revert / bad data), or
 * throws on a network failure. */
async function viewCall(provider, to, fn, args = []) {
  try {
    const data = await provider.call({ to, data: VIEW_ABI.encodeFunctionData(fn, args) });
    if (!data || data === "0x") return undefined;
    return VIEW_ABI.decodeFunctionResult(fn, data)[0];
  } catch (err) {
    if (err?.code === "CALL_EXCEPTION" || err?.code === "BAD_DATA") return undefined;
    throw err;
  }
}

// The liquidity + lock caches, read from R2 at most every 10 minutes (they refresh hourly anyway).
let liquidityMemo = null;
async function liquidityCaches() {
  if (liquidityMemo && Date.now() - liquidityMemo.at < 10 * 60 * 1000) return liquidityMemo.value;
  const [liquidity, locks] = await Promise.all([getTokenLiquidityCache().catch(() => null), getTokenLocksCache().catch(() => null)]);
  const value = liquidity?.liquidityUsd && locks?.locksByAddress ? { liquidity, locks } : null;
  liquidityMemo = { at: Date.now(), value };
  return value;
}

/** The address's code hash (keccak256 of its runtime bytecode), or null for no code. */
async function codeHashOf(provider, address) {
  const code = await provider.getCode(address);
  return code && code !== "0x" ? ethers.keccak256(code) : null;
}

/** Cheap change detection for the cache: code hash, EIP-1967 implementation, owner(). */
export async function fetchFingerprint(address, provider = contractCheckProvider()) {
  const codeHash = await codeHashOf(provider, address);
  const implementation = codeHash ? slotAddress(await provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT)) : null;
  let owner = null;
  if (codeHash) {
    const o = await viewCall(provider, address, "owner").catch(() => undefined);
    owner = o === undefined ? null : String(o).toLowerCase();
  }
  return { codeHash, implementation: implementation ? implementation.toLowerCase() : null, owner };
}

export async function fetchContractData(addressInput, { provider = contractCheckProvider(), now = Date.now() } = {}) {
  const address = ethers.getAddress(addressInput);
  const raw = { address, now, unavailable: [] };
  const miss = (what) => raw.unavailable.push(what);
  const bs = async (path, what) => {
    try {
      return await fetchBlockscoutJsonOrNull(path);
    } catch {
      miss(what);
      return undefined;
    }
  };
  // Published source for an address: its own verified source, or — for an unverified contract — the source
  // of a verified contract with identical bytecode (Blockscout's "verified twin", e.g. every ElectroSwap V2
  // pair). null when there's neither; undefined when the explorer couldn't be asked.
  const sourceFor = async (addr, info, what) => {
    if (!info?.is_contract) return null;
    const sc = await bs(`/smart-contracts/${addr}`, what);
    if (!sc) return sc;
    if (sc.is_verified || (sc.verified_twin_address_hash && sc.source_code)) return sc;
    return null;
  };

  // Code first: no code at this address means it isn't a contract (an EOA or nothing).
  try {
    raw.codeHash = await codeHashOf(provider, address);
  } catch {
    miss("rpc:code");
  }
  raw.addressInfo = await bs(`/addresses/${address}`, "explorer:address");
  if (raw.codeHash === null && raw.addressInfo !== undefined) {
    raw.addressInfo = raw.addressInfo ? { ...raw.addressInfo, is_contract: false } : { is_contract: false };
    raw.known = await lookupKnownContract(address);
    return raw;
  }

  if (raw.addressInfo) raw.contract = await sourceFor(address, raw.addressInfo, "explorer:source");

  // Proxy: EIP-1967 slots (authoritative), then whatever Blockscout says the implementation is.
  try {
    raw.slots = {
      implementation: slotAddress(await provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT)),
      admin: slotAddress(await provider.getStorage(address, EIP1967_ADMIN_SLOT)),
    };
  } catch {
    miss("rpc:slots");
    raw.slots = {};
  }
  const implAddress = raw.slots.implementation || raw.contract?.implementations?.[0]?.address || null;
  if (implAddress) {
    const implInfo = await bs(`/addresses/${implAddress}`, "explorer:implementation");
    raw.implementation = {
      address: implAddress,
      addressInfo: implInfo,
      contract: implInfo ? await sourceFor(implAddress, implInfo, "explorer:implementationSource") : implInfo,
      codeHash: await codeHashOf(provider, implAddress).catch(() => null),
    };
  }
  if (raw.slots.admin) {
    const a = { address: raw.slots.admin };
    try {
      a.isContract = (await codeHashOf(provider, raw.slots.admin)) !== null;
      if (a.isContract) {
        const sc = await bs(`/smart-contracts/${raw.slots.admin}`, "explorer:adminSource");
        a.contractName = sc?.name || null;
        a.verified = Boolean(sc);
        const o = await viewCall(provider, raw.slots.admin, "owner");
        if (o !== undefined) {
          a.owner = o;
          a.ownerIsContract = (await codeHashOf(provider, o)) !== null;
        }
      }
    } catch {
      miss("rpc:admin");
    }
    raw.admin = a;
  }

  // Ownership, read live from the address itself (a proxy delegates to its implementation).
  try {
    const own = {};
    for (const fn of ["owner", "getOwner"]) {
      const o = await viewCall(provider, address, fn);
      if (o !== undefined) {
        own.owner = String(o);
        own.source = `${fn}()`;
        break;
      }
    }
    if (own.owner && own.owner !== ethers.ZeroAddress) {
      own.ownerIsContract = (await codeHashOf(provider, own.owner)) !== null;
      if (own.ownerIsContract) own.ownerContract = await bs(`/smart-contracts/${own.owner}`, "explorer:ownerSource");
    }
    const deployer = raw.addressInfo?.creator_address_hash;
    const hasRoleProbe = await viewCall(provider, address, "hasRole", [DEFAULT_ADMIN_ROLE, deployer || ethers.ZeroAddress]);
    if (hasRoleProbe !== undefined) {
      own.accessControl = { present: true, deployerIsAdmin: deployer ? Boolean(hasRoleProbe) : null, adminHolders: null };
      const count = await viewCall(provider, address, "getRoleMemberCount", [DEFAULT_ADMIN_ROLE]);
      if (count !== undefined) {
        own.accessControl.adminHolders = [];
        for (let i = 0n; i < count && i < 10n; i++) own.accessControl.adminHolders.push(String(await viewCall(provider, address, "getRoleMember", [DEFAULT_ADMIN_ROLE, i])));
      }
    }
    raw.ownership = own;
  } catch {
    miss("rpc:ownership");
    raw.ownership = { failed: true };
  }

  // ElectroSwap liquidity and LP locks for a token — the shared R2 caches the Tokens tab uses
  // (tokenLiquidityCache.js / tokenLocksCache.js). null = not listed; undefined = caches unreadable.
  if (raw.addressInfo?.token) {
    const caches = await liquidityCaches();
    if (!caches) miss("cache:liquidity");
    else {
      const a = address.toLowerCase();
      const usd = caches.liquidity.liquidityUsd?.[a];
      raw.liquidity = usd == null ? null : { usd, poolCount: caches.liquidity.poolCounts?.[a] ?? null, locks: caches.locks?.locksByAddress?.[a] ?? null };
    }
  }

  // Custom roles (e.g. CORE's taxWallet): the current holder of each state variable the source gates powers
  // on, when the ABI has a no-argument address getter for it. A zero address means nobody can use them.
  raw.roleHolders = {};
  const target = raw.implementation ? raw.implementation.contract : raw.contract;
  for (const name of findPrivilegedPowers(target?.abi, target).customControllers) {
    const getter = (target.abi || []).find((f) => f.type === "function" && f.name === name && !(f.inputs || []).length && f.outputs?.length === 1 && f.outputs[0].type === "address");
    if (!getter) continue;
    try {
      const iface = new ethers.Interface([`function ${name}() view returns (address)`]);
      const data = await provider.call({ to: address, data: iface.encodeFunctionData(name) });
      raw.roleHolders[name] = data && data !== "0x" ? String(iface.decodeFunctionResult(name, data)[0]) : null;
    } catch {
      miss("rpc:roles");
    }
  }

  // Token, age and activity.
  if (raw.addressInfo?.token) {
    raw.token = await bs(`/tokens/${address}`, "explorer:token");
    const h = await bs(`/tokens/${address}/holders`, "explorer:holders");
    raw.holders = h ? h.items || [] : h;
  }
  raw.counters = await bs(`/addresses/${address}/counters`, "explorer:counters");
  if (raw.addressInfo?.creation_transaction_hash) {
    const tx = await bs(`/transactions/${raw.addressInfo.creation_transaction_hash}`, "explorer:creationTx");
    raw.creationTx = tx ? { timestamp: tx.timestamp } : tx;
  }
  // Last activity: the newest of a direct transaction, a token transfer, and an event the contract emitted
  // (most activity reaches a pool or token through a router, so it never shows as a transaction to it).
  const stamps = [];
  const txs = await bs(`/addresses/${address}/transactions`, "explorer:transactions");
  if (txs?.items?.[0]?.timestamp) stamps.push(txs.items[0].timestamp);
  if (raw.addressInfo?.token) {
    const tt = await bs(`/tokens/${address}/transfers`, "explorer:transfers");
    if (tt?.items?.[0]?.timestamp) stamps.push(tt.items[0].timestamp);
  }
  const logs = await bs(`/addresses/${address}/logs`, "explorer:logs");
  if (logs?.items?.[0]?.block_number) {
    const block = await provider.getBlock(logs.items[0].block_number).catch(() => null);
    if (block?.timestamp) stamps.push(new Date(block.timestamp * 1000).toISOString());
  }
  raw.lastActivityAt = stamps.length ? stamps.map((s) => new Date(s).toISOString()).sort().at(-1) : null;

  // .etn names (the shared resolver; its short-address fallback means "no name").
  const resolve = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);
  raw.names = {};
  const who = [address, raw.addressInfo?.creator_address_hash, raw.ownership?.owner, raw.slots?.admin, raw.admin?.owner, ...Object.values(raw.roleHolders)].filter((a) => a && a !== ethers.ZeroAddress);
  for (const a of [...new Set(who.map((x) => x.toLowerCase()))]) {
    const n = await resolve(ethers.getAddress(a)).catch(() => null);
    raw.names[a] = n && n !== shortAddress(ethers.getAddress(a)) ? n : null;
  }

  raw.known = await lookupKnownContract(address);
  // Who deployed it, if we know them (e.g. ElectroSwap's V2 factory creates every V2 pair) — a label, not a risk input.
  if (raw.addressInfo?.creator_address_hash) raw.deployerKnown = await lookupKnownContract(raw.addressInfo.creator_address_hash);
  return raw;
}
