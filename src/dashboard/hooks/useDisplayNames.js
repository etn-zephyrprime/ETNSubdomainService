import { useEffect, useState } from "react";
import { useReverseRecord } from "../../hooks/useReverseRecord.js";

// Resolves primary/ENS names for wallet addresses shown across the Core tier dashboard (Total
// Portfolio Balance, Balance History, Wallet Alerts) — everywhere those used to show a short hex
// address only. Cache and in-flight state are MODULE-LEVEL (not per-hook-instance) so the same
// wallet address resolved once — say, in the Balance History panel — is already known by the time
// the Wallet Alerts panel below it renders the exact same address, instead of each panel making
// its own redundant lookup. useReverseRecord.js's getPrimaryName already does the real ENS-style
// reverse-registrar read (see that hook's own comment) — this only adds page-wide caching and a
// short-hex fallback on top of it.
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
      const promise = getPrimaryName(address)
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
