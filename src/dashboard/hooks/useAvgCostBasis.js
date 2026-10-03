import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Average purchase price per held token (USD + ETN), combined across every covered wallet — GET
// /api/premium/avg-cost-basis, same signed-ownership + Core tier gate as every other Core Tier
// endpoint. Backs CoreTierPortfolio.jsx's Combined Holdings list; separate from
// useCombinedPortfolio.js's own Blockscout balance read since this is this app's own cost-basis
// data (the FIFO ledger), not anything a block explorer would show.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useAvgCostBasis() {
  const getAvgCostBasis = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/avg-cost-basis?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { avgCostByToken: { [lowercased tokenAddress]: { avgCostUsd, avgCostEtn: number|null } } }
  }, []);

  return { getAvgCostBasis };
}
