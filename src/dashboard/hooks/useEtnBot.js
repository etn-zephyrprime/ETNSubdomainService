import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// The ETN accumulator bot's report (backend/services/etnBotReport.js) — owner-only: the backend only
// answers a signed request from one of its ETN_BOT_VIEWERS wallets.
export const ETN_BOT_VIEWERS = new Set(["0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099", "0x696a7b9ea5c86da15d569d99d75ed788cce4db2e"]);

export function useEtnBot() {
  const getEtnBot = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/etn-bot?${params}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return res.json();
  }, []);
  return { getEtnBot };
}
