import { useEffect, useState } from "react";
import { useBlockscout } from "./useBlockscout.js";
import { isSpamTokenName } from "../utils/format.js";

// Resolves a token symbol/name for CoreTierAlerts.jsx's Token Price Alerts list, which used to
// show the raw contract address only. Same shared-cache/subscriber shape as useDisplayNames.js
// (module-level, not per-hook-instance) — see that file's own comment for why.
const cache = new Map(); // lowercased address -> string (symbol/name) | null (unresolved) | Promise
const subscribers = new Set();

function notifyAll() {
  subscribers.forEach((fn) => fn());
}
function shortAddr(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function useTokenNames(addresses) {
  const { getToken } = useBlockscout();
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
      if (cache.has(address)) continue;
      const promise = getToken(address)
        .then((res) => {
          cache.set(address, res?.symbol || res?.name || null);
          notifyAll();
        })
        .catch(() => {
          cache.set(address, null);
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
    // Deliberately checks the RAW cached value, never resolve()'s short-hex fallback — a token
    // whose name hasn't resolved yet must never be flagged spam off a coincidental match against
    // its own address text (e.g. a "0xdead..."-style burn/vanity address would otherwise
    // wrongly look like a "dead"-named spam token before its real name/symbol ever loads).
    // Resolves to false (never spam) for anything not yet a confirmed string, same "never hide on
    // uncertainty" principle as noLiquidityTokens elsewhere.
    isSpam(address) {
      if (!address) return false;
      const cached = cache.get(address.toLowerCase());
      return typeof cached === "string" && isSpamTokenName(cached);
    },
  };
}
