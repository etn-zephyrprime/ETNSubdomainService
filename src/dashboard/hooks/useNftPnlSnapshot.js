import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET /api/premium/nft-pnl — Core tier's ongoing NFT PnL feature (nftPnlService.js). Same auth/
// error conventions as usePnlSnapshot.js's own getLiveSnapshot.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useNftPnlSnapshot() {
  // Same "real wait, not a poll tick" cost shape as usePnlSnapshot's getLiveSnapshot — a full
  // transfer-history walk + FIFO replay per wallet, just without any live pricing on top (NFT PnL
  // needs none — see nftPnlService.js's own header comment), so somewhat cheaper in practice.
  const getNftPnlSnapshot = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/nft-pnl?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet, combined, failed: [address,...] }
  }, []);

  return { getNftPnlSnapshot };
}
