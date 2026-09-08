import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Public (no signature, no Core tier membership) PnL preview for CoreTierDemo.jsx — GET
// /api/premium/demo/pnl, always the one fixed demo wallet server-side (coreTierDemoRouter.js never
// accepts a wallet from the client). Balance History needs no equivalent hook — CoreTierDemo.jsx
// calls useBlockscout.js/useEtnPriceHistory.js/historicalBalance.js directly, same public sources
// CoreTierBalanceHistory.jsx itself already uses.
export function useCoreTierDemo() {
  const getDemoPnl = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/demo/pnl`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return res.json(); // { snapshot, history: [{date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd}] }
  }, []);

  return { getDemoPnl };
}
