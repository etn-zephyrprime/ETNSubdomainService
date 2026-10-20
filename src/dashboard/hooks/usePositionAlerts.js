import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET/POST/DELETE /api/premium/position-alerts — same shape/conventions as usePortfolioAlerts.js.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function usePositionAlerts() {
  const getPositionAlerts = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/position-alerts?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { alerts, ilRearmPoints, minIlThresholdPct, maxIlThresholdPct }
  }, []);

  // Creates or updates the owner's one alert of `alertType` ({ alertType, thresholdPct? }).
  const savePositionAlert = useCallback(async (wallet, signature, timestamp, alertInput) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/position-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, ...alertInput }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { alert }
  }, []);

  const removePositionAlert = useCallback(async (wallet, signature, timestamp, alertId) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/position-alerts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, alertId }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { removed: true }
  }, []);

  return { getPositionAlerts, savePositionAlert, removePositionAlert };
}
