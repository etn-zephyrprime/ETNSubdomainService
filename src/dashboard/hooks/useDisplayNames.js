import { useEffect, useState } from "react";
import { useReverseRecord } from "../../hooks/useReverseRecord.js";
import { useOwnedNames } from "../../hooks/useOwnedNames.js";

// Resolves display names for wallet addresses shown across the Core tier dashboard and the Tokens
// tab's burn lists — everywhere those used to show a short hex address only. Cache and in-flight
// state are MODULE-LEVEL (not per-hook-instance) so the same wallet address resolved once — say, in
// the Balance History panel — is already known by the time the Wallet Alerts panel below it renders
// the exact same address, instead of each panel making its own redundant lookup.
//
// Two-step resolution, since most wallets never bother setting a primary/reverse record even when
// they own a name through this app (confirmed: e.g. the Top Burners table showed bare addresses for
// wallets that DO own a subdomain here, just never called setName) — a strict reverse-record-only
// lookup silently under-resolves for exactly that reason:
//   1. useReverseRecord.js's getPrimaryName — the real ENS-style reverse-registrar read, verified
//      against forward resolution (see that hook's own comment).
//   2. If that comes back empty, useOwnedNames.js's cache of every name this app has ever wrapped —
//      falls back to any name the address currently OWNS, even without a reverse record set. Picks
//      the alphabetically-first if it owns more than one (same order getNamesOwnedBy already sorts
//      by), a deterministic pick rather than claiming to know which one the owner would prefer.
// Either way this is a display convenience, not an identity claim the app is vouching for the way a
// verified primary name is — but a bare hex address is worse UX than "some name they clearly own."
const cache = new Map(); // lowercased address -> string (name) | null (confirmed none) | Promise (in flight)
const subscribers = new Set(); // () => void — one per mounted hook instance, notified on ANY resolution

function notifyAll() {
  subscribers.forEach((fn) => fn());
}

function shortAddr(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * `addresses`: any array of addresses (nulls/undefined tolerated and ignored) to resolve.
 * Returns `{ resolve(address) }` — `resolve` gives the primary name if known, else a short hex
 * fallback, for ANY address (not just ones passed into this call) since the cache is shared
 * page-wide; pass the addresses this component actually needs so they get kicked off if not
 * already cached/in flight.
 */
export function useDisplayNames(addresses) {
  const { getPrimaryName } = useReverseRecord();
  const { getNamesOwnedBy } = useOwnedNames();
  const [, setTick] = useState(0);
  const key = (addresses || []).filter(Boolean).map((a) => a.toLowerCase()).sort().join(",");

  useEffect(() => {
    const rerender = () => setTick((n) => n + 1);
    subscribers.add(rerender);
    return () => subscribers.delete(rerender);
  }, []);

  useEffect(() => {
    if (!key) return;
    for (const address of key.split(",")) {
      if (cache.has(address)) continue; // already resolved, confirmed-none, or in flight
      const promise = (async () => {
        let name = null;
        try {
          name = await getPrimaryName(address);
        } catch {
          // Reverse-record read failed — fall through to the ownership fallback below rather than
          // giving up outright; a failed reverse lookup says nothing about whether this address
          // owns a name.
        }
        if (!name) {
          try {
            const owned = await getNamesOwnedBy(address);
            name = owned[0]?.name || null;
          } catch {
            // Ownership fallback failed too — resolve() falls back to short hex either way.
          }
        }
        return name;
      })()
        .then((name) => {
          cache.set(address, name || null);
          notifyAll();
        })
        .catch(() => {
          cache.set(address, null); // failed lookup falls back to short hex, same as "no name set"
          notifyAll();
        });
      cache.set(address, promise);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    resolve(address) {
      if (!address) return "Unknown";
      const cached = cache.get(address.toLowerCase());
      return typeof cached === "string" ? cached : shortAddr(address);
    },
  };
}
