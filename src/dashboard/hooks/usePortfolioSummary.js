import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Last-known Core Tier portfolio summary (see backend/db/portfolioSummaryCache.js) — read on load so
// the Portfolio tab shows real numbers immediately, saved back once the live figures have settled.
// Same signed-ownership + Core tier gate as every other Core tier endpoint.
export function usePortfolioSummary() {
  const getPortfolioSummary = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-summary?${params}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json(); // { summary: { perWallet: [{address, native, tokens, liquidity, staking}], hasUnpriced } | null, computedAt }
  }, []);

  const savePortfolioSummary = useCallback(async (wallet, signature, timestamp, summary) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/portfolio-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, summary }),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
  }, []);

  return { getPortfolioSummary, savePortfolioSummary };
}
