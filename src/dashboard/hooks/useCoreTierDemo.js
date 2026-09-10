import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Public (no signature, no Core tier membership) full-dashboard preview for CoreTierDemo.jsx — GET
// /api/premium/demo/pnl, always the three fixed demo wallets server-side (coreTierDemoRouter.js
// never accepts a wallet from the client, and never returns their real addresses either — see that
// file's own header comment). Balance History needs no equivalent hook — CoreTierDemo.jsx calls
// useBlockscout.js/useEtnPriceHistory.js/historicalBalance.js directly, same public sources
// CoreTierBalanceHistory.jsx itself already uses (an intentional, narrower exception — see that
// component's own comment).
export function useCoreTierDemo() {
  const getDemoPnl = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/demo/pnl`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    // { snapshot, perWallet: [{walletIndex, currentValueUsd, unrealizedPnlUsd, realizedPnlUsd}],
    //   history, categoryHistory: {liquidity, farm_staking}, defiPositions, liquidityPositions,
    //   nftPnl, combinedHoldings: {totalCoinBalance, tokens}, generatedAt }
    // Served from a static, pre-anonymized snapshot (see coreTierDemoState.js) rather than computed
    // live per request — generatedAt is when that snapshot was last generated, not "now".
    return res.json();
  }, []);

  return { getDemoPnl };
}
