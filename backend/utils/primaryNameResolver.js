// backend/utils/primaryNameResolver.js
//
// Resolves a wallet's primary ("reverse") ENS name via ReverseRegistrar + the resolver it points
// to — the same three-call chain activatedDomainsCache.js/marketplaceSellersCache.js already use
// for the homepage table and marketplace listings. Centralized here rather than duplicated
// per-file like most small helpers in this codebase (see queryLogsChunked's "fine to drift
// independently" comment elsewhere) specifically because getting this exact lookup wrong already
// caused two real production bugs (see activatedDomainsCache.js's header comment): both traced
// back to re-fetching defaultResolver() redundantly per-address under concurrency, which Ankr's
// public RPC rejects as too large a batch. Every Telegram bot that shows a wallet address shares
// this one fix instead of each new call site getting its own chance to reintroduce it.
import { ethers } from "ethers";

// Only used for the owned-but-not-reverse-set fallback below — Blockscout already does the
// NameWrapper-ownership indexing this needs, so this asks it directly rather than re-deriving
// ownership from logs/NFT balances ourselves.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";

const REVERSE_REGISTRAR_ABI = [
  "function node(address addr) view returns (bytes32)",
  "function defaultResolver() view returns (address)",
];
const RESOLVER_ABI = ["function name(bytes32 node) view returns (string)"];

// Same address src/config.js's own ENS_REGISTRY_ADDRESS hardcodes for the frontend — needed here
// to VERIFY a reverse-claimed name (see verifyPrimaryName's own comment on why that's necessary,
// not optional).
const ENS_REGISTRY_ADDRESS = process.env.ENS_REGISTRY_ADDRESS || "0x6F311F2212593165988Dff84977e24C1005dBb85";
const REGISTRY_ABI = ["function resolver(bytes32 node) view returns (address)"];
const FORWARD_RESOLVER_ABI = ["function addr(bytes32 node) view returns (address)"];

export function shortAddress(address) {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Confirms a reverse-claimed primary name's FORWARD resolution actually points back to `addr` —
 * confirmed live (2026-09-18) that a wallet's reverse record can keep claiming a name it no longer
 * owns, indefinitely: transferring a name/subname to a new owner does NOT clear the OLD owner's own
 * reverse pointer unless they explicitly do so, and nothing in ENS enforces the two stay in sync.
 * Real production example that surfaced this: a Telegram swap alert displayed "club.electroswap.etn"
 * for a wallet that had since transferred that exact subname away — its reverse record still
 * claimed it, but the name's own forward resolution (Registry.resolver(node) -> that resolver's
 * addr(node)) pointed to a completely different, unrelated address. Used by every caller in this
 * codebase that resolves a reverse name before trusting it — see activatedDomainsCache.js's and
 * marketplaceSellersCache.js's own resolvePrimaryName, and src/hooks/useReverseRecord.js for the
 * frontend's independent copy of this same check (can't share this module across the frontend/
 * backend boundary, same as ENS_REGISTRY_ADDRESS/REVERSE_REGISTRAR_ADDRESS already being
 * independently duplicated per side).
 *
 * Deliberately never cached — a name's forward owner can change at any moment, exactly the
 * scenario this exists to catch — and never throws: any failure (no resolver set for the name, a
 * bad call) is treated as "can't verify" -> false, never "assume it's fine".
 */
export async function verifyPrimaryName(provider, name, addr) {
  try {
    const node = ethers.namehash(name);
    const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const resolverAddr = await registry.resolver(node);
    if (resolverAddr === ethers.ZeroAddress) return false;
    const resolver = new ethers.Contract(resolverAddr, FORWARD_RESOLVER_ABI, provider);
    const forwardAddr = await resolver.addr(node);
    return String(forwardAddr).toLowerCase() === String(addr).toLowerCase();
  } catch (err) {
    console.warn(`⚠️  Failed to verify primary name "${name}" for ${addr}:`, err.message);
    return false;
  }
}

/**
 * Returns an async `resolveDisplayName(addr) -> string` bound to one ReverseRegistrar. Always
 * resolves to a displayable string — the wallet's primary name if it has one set AND it verifies
 * (see verifyPrimaryName above); failing that, a name it merely OWNS but never set as primary (via
 * Blockscout's own ownership indexing, see ownedNameFromBlockscout below); failing that,
 * `shortAddress(addr)` — so every caller gets a best-effort display name without having to handle
 * the null/error/stale case itself.
 *
 * `defaultResolver()` is a single global value (not address-dependent) that effectively never
 * changes, so it's fetched once and cached for the life of the process — these Telegram bots
 * each resolve at most a handful of addresses per poll tick, not the bulk/concurrent resolution
 * activatedDomainsCache.js does, so there's no need to refresh it per cycle the way that file
 * does. A failed fetch clears the cache so the next call retries rather than failing forever.
 */
export function createPrimaryNameResolver(provider, reverseRegistrarAddress) {
  const reverseRegistrar = new ethers.Contract(reverseRegistrarAddress, REVERSE_REGISTRAR_ABI, provider);
  let resolverPromise = null;

  function getResolver() {
    if (!resolverPromise) {
      resolverPromise = reverseRegistrar
        .defaultResolver()
        .then((addr) => (addr === ethers.ZeroAddress ? null : new ethers.Contract(addr, RESOLVER_ABI, provider)))
        .catch((err) => {
          resolverPromise = null; // let the next call retry instead of caching a failure forever
          throw err;
        });
    }
    return resolverPromise;
  }

  // Fallback for a wallet that OWNS a name but never set it as primary (reverse record) — confirmed
  // live: a wallet trading on Core Clash showed as a raw address in every Telegram alert despite
  // owning a name outright, because the reverse lookup above only ever answers "what's set as
  // primary", never "what does this address own". Blockscout's own address endpoint already
  // surfaces ownership via `ens_domain_name`, so this asks it directly rather than re-deriving
  // NameWrapper ownership from logs/balances ourselves. Best-effort like every other lookup here —
  // a failed/slow Blockscout call just means no fallback, not a broken message.
  async function ownedNameFromBlockscout(addr) {
    try {
      const res = await fetch(`${EXPLORER_BASE_URL}/api/v2/addresses/${addr}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.ens_domain_name || null;
    } catch {
      return null;
    }
  }

  return async function resolveDisplayName(addr) {
    let primaryName = null;
    try {
      const resolver = await getResolver();
      if (resolver) {
        const node = await reverseRegistrar.node(addr);
        const claimedName = await resolver.name(node);
        // Verify before trusting — see verifyPrimaryName's own comment on why a reverse record
        // alone isn't reliable (a wallet can keep claiming a name it's since transferred away).
        if (claimedName && (await verifyPrimaryName(provider, claimedName, addr))) {
          primaryName = claimedName;
        }
      }
    } catch (err) {
      console.warn(`⚠️  Failed to resolve primary name for ${addr}:`, err.message);
    }
    if (primaryName) return primaryName;

    const ownedName = await ownedNameFromBlockscout(addr);
    return ownedName || shortAddress(addr);
  };
}
