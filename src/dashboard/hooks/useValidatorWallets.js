import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/validatorWalletsCache.js publishes every Electroneum validator's ETN balance, its
// daily balance over the last 90 days, and every outgoing transfer it has made — see that file's
// own header comment. Same no-fallback-on-failure pattern as useTeamWallets.js.
const EMPTY = { validators: [], outgoing: [], series: [], updatedAt: null };

export function useValidatorWallets() {
  const getValidatorWallets = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("validator-wallets.json"));
      if (!res.ok) return EMPTY;
      const data = await res.json();
      return {
        validators: Array.isArray(data?.validators) ? data.validators : [],
        outgoing: Array.isArray(data?.outgoing) ? data.outgoing : [],
        series: Array.isArray(data?.series) ? data.series : [],
        updatedAt: data?.updatedAt || null,
      };
    } catch (err) {
      console.warn("Validator wallets fetch failed:", err.message);
      return EMPTY;
    }
  }, []);

  return { getValidatorWallets };
}
