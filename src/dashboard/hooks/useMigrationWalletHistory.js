import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/migrationWalletTracker.js publishes one specific wallet's balance history (~12
// months) plus its own recent transaction activity to R2 — see that file's own header comment for
// which wallet and why it's watched. Same no-fallback-on-failure pattern as this app's other
// R2-backed hooks: a fetch failure just means the section shows nothing, nothing else breaks.
export function useMigrationWalletHistory() {
  const getMigrationWalletHistory = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("migration-wallet-history.json"));
      if (!res.ok) return { balance: null, series: [], migrationEvent: null, transactions: [], updatedAt: null };
      const data = await res.json();
      return {
        balance: data?.balance ?? null,
        series: Array.isArray(data?.series) ? data.series : [],
        migrationEvent: data?.migrationEvent ?? null,
        transactions: Array.isArray(data?.transactions) ? data.transactions : [],
        updatedAt: data?.updatedAt || null,
      };
    } catch (err) {
      console.warn("Migration wallet history fetch failed:", err.message);
      return { balance: null, series: [], migrationEvent: null, transactions: [], updatedAt: null };
    }
  }, []);

  return { getMigrationWalletHistory };
}
