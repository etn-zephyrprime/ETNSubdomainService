import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Diamond Hands Score — GET /api/premium/diamond-hands, same signed-ownership + Core tier
// membership gate as every other Core tier endpoint. See backend/services/diamondHandsService.js's
// own header comment for the full methodology (this is a holding-BEHAVIOR score, not a PnL
// figure — on-chain only, no CEX, recomputed live on every call, never frozen).
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useDiamondHandsScore() {
  const getDiamondHandsScore = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/diamond-hands?${params}`);
    await parseErrorOrThrow(res);
    // { asOf, portfolio: {components, score, tier, subScores}, perWallet: [{walletAddress,
    //   components, score, tier, subScores}], perAsset: [{tokenAddress, type: "native"|"token"|
    //   "lp"|"nft", components, score, tier, subScores}] (an "nft" row's tokenAddress is the
    //   COLLECTION address, pooling every tokenId ever held/sold in it -- see
    //   diamondHandsService.js's own classifyAssetKey), failed: [walletAddress, ...] }
    return res.json();
  }, []);

  return { getDiamondHandsScore };
}
