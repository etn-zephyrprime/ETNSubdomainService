import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET/POST /api/premium/portfolio-digest — a plain on/off toggle (no per-alert config), so this is
// simpler than useWalletAlerts.js/usePortfolioAlerts.js: no add/remove list, just get-current-state
// and set-enabled.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function usePortfolioDigest() {
  const getDigestStatus = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-digest?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { enabled, lastSentDate, lastSentTotalUsd }
  }, []);

  const setDigestEnabled = useCallback(async (wallet, signature, timestamp, enabled) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, enabled }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { enabled, lastSentDate, lastSentTotalUsd }
  }, []);

  return { getDigestStatus, setDigestEnabled };
}
