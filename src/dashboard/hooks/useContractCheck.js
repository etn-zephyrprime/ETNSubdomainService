import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Contract Check API (backend/utils/contractCheckRouter.js). Everything needs the Core Tier wallet
// signature; the free Tokens tab only reads the static badge file (useContractBadges.js).
async function asJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.remaining = data.remaining;
    throw err;
  }
  return data;
}

const base = `${PNL_BACKEND_URL}/api/contract-check`;

export function useContractCheck() {

  /** The cached summary, or (with `question`) an answer + remaining questions today. */
  const explain = useCallback(async (auth, address, question) => {
    const res = await fetch(`${base}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: auth.address, signature: auth.signature, timestamp: auth.timestamp, address, ...(question ? { question } : {}) }),
    });
    return asJson(res);
  }, []);

  const authQuery = (auth) => new URLSearchParams({ wallet: auth.address, signature: auth.signature, timestamp: String(auth.timestamp) });

  /** `{ facts, disclaimer }` for an address or name.etn. */
  const getFacts = useCallback(async (auth, target) => asJson(await fetch(`${base}/${encodeURIComponent(target)}?${authQuery(auth)}`)), []);

  /** Suggestions for the search box. */
  const search = useCallback(async (auth, q) => (await asJson(await fetch(`${base}/search?q=${encodeURIComponent(q)}&${authQuery(auth)}`))).results || [], []);
  const getUsedContracts = useCallback(async (auth) => (await asJson(await fetch(`${base}/used?${authQuery(auth)}`))).contracts || [], []);
  const getApprovals = useCallback(async (auth, refresh = false) => asJson(await fetch(`${base}/approvals?${authQuery(auth)}${refresh ? "&refresh=1" : ""}`)), []);

  return { getFacts, search, explain, getUsedContracts, getApprovals };
}
