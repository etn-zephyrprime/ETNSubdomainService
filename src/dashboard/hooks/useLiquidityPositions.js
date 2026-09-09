import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Live value of a member's directly-held LP/V3 positions — POST /api/premium/liquidity-positions,
// same signed-ownership + Core tier membership gate as every other Core tier endpoint. A POST (the
// only Core tier endpoint besides tracked-wallets that is one) because valuing a V2 LP token needs
// candidate token addresses/balances the caller already has loaded (useCombinedPortfolio.js), not
// a fresh Blockscout fetch this endpoint would otherwise have to duplicate — see
// premiumDashboardRouter.js's own comment on that endpoint for why.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useLiquidityPositions() {
  // `walletTokens`: { [lowercased wallet address]: [{ address, decimals, rawBalance }] } — every
  // fungible (non-NFT, non-spam) token a covered wallet holds, the V2 LP-pool candidate list.
  const getLiquidityPositions = useCallback(async (wallet, signature, timestamp, walletTokens) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/liquidity-positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, walletTokens }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, v2Positions, v3Positions, totalUsd, hasUnpriced, lpTokenAddresses}], combined: {totalUsd, hasUnpriced, lpTokenAddresses} }
  }, []);

  return { getLiquidityPositions };
}
