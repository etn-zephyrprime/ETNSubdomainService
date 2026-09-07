import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET/POST/DELETE /api/premium/portfolio-alerts — same shape/conventions as useTokenPriceAlerts.js.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function usePortfolioAlerts() {
  const getPortfolioAlerts = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-alerts?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { alerts, maxAlerts }
  }, []);

  const addPortfolioAlert = useCallback(async (wallet, signature, timestamp, alertInput) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, ...alertInput }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { alert, maxAlerts }
  }, []);

  const removePortfolioAlert = useCallback(async (wallet, signature, timestamp, alertId) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-alerts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, alertId }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { removed: true }
  }, []);

  return { getPortfolioAlerts, addPortfolioAlert, removePortfolioAlert };
}
