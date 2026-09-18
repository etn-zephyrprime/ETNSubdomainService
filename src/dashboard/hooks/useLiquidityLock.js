import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// GET /api/token-liquidity-lock/:address — backend/utils/tokenLiquidityLockRouter.js's lazy,
// per-token, in-memory-cached wrapper around ElectroSwap's expensive (2000 credit) /liquidity-
// locks endpoint. Called on-demand from TokenDetail.jsx (one token at a time, whichever a visitor
// actually opens), never in bulk — see that router's own header comment for why.
export function useLiquidityLock() {
  const getLiquidityLock = useCallback(async (address) => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-liquidity-lock/${address}`);
    if (!res.ok) return { available: false };
    // { available: false } | { available: true, count, latestUnlockAt: ISOstring|null }
    return res.json();
  }, []);

  return { getLiquidityLock };
}
