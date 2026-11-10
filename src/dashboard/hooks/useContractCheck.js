import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Contract Check API (backend/utils/contractCheckRouter.js). Facts and search are public; the
// explanation, "contracts you've used" and approvals need the Core Tier wallet signature.
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
  /** `{ facts, disclaimer }` for an address or name.etn. */
  const getFacts = useCallback(async (target) => asJson(await fetch(`${base}/${encodeURIComponent(target)}`)), []);

  /** Suggestions for the search box. */
  const search = useCallback(async (q) => (await asJson(await fetch(`${base}/search?q=${encodeURIComponent(q)}`))).results || [], []);

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
  const getUsedContracts = useCallback(async (auth) => (await asJson(await fetch(`${base}/used?${authQuery(auth)}`))).contracts || [], []);
  const getApprovals = useCallback(async (auth, refresh = false) => asJson(await fetch(`${base}/approvals?${authQuery(auth)}${refresh ? "&refresh=1" : ""}`)), []);

  return { getFacts, search, explain, getUsedContracts, getApprovals };
}
