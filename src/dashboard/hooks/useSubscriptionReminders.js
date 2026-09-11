import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET/POST /api/premium/subscription-reminders — a plain on/off toggle (no per-alert config),
// same shape as usePortfolioDigest.js: get-current-state and set-enabled, nothing to add/remove.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useSubscriptionReminders() {
  const getReminderStatus = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/subscription-reminders?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { enabled, lastReminderTierDays, lastReminderExpiry }
  }, []);

  const setReminderEnabled = useCallback(async (wallet, signature, timestamp, enabled) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/subscription-reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, enabled }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { enabled, lastReminderTierDays, lastReminderExpiry }
  }, []);

  return { getReminderStatus, setReminderEnabled };
}
