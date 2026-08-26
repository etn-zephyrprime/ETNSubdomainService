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

const REVERSE_REGISTRAR_ABI = [
  "function node(address addr) view returns (bytes32)",
  "function defaultResolver() view returns (address)",
];
const RESOLVER_ABI = ["function name(bytes32 node) view returns (string)"];

export function shortAddress(address) {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Returns an async `resolveDisplayName(addr) -> string` bound to one ReverseRegistrar. Always
 * resolves to a displayable string — the wallet's primary name if it has one set, otherwise
 * `shortAddress(addr)` — so every caller gets "name, falling back to short address" without
 * having to handle the null/error case itself.
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

  return async function resolveDisplayName(addr) {
    try {
      const resolver = await getResolver();
      if (!resolver) return shortAddress(addr);
      const node = await reverseRegistrar.node(addr);
      const name = await resolver.name(node);
      return name || shortAddress(addr);
    } catch (err) {
      console.warn(`⚠️  Failed to resolve primary name for ${addr}:`, err.message);
      return shortAddress(addr);
    }
  };
}
