import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET /api/premium/what-if-holdings, POST /api/premium/what-if-sell and /what-if-exit — see
// backend/services/whatIfSimulator.js. Same error conventions as the other Core tier hooks.
async function parseErrorOrThrow(res) {
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error === "Core tier membership required" || !data.error ? "CORE_ACCESS_REQUIRED" : data.error);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useWhatIfSimulator() {
  const getSellableHoldings = useCallback(async (wallet, signature, timestamp, walletAddress) => {
    const params = new URLSearchParams({ wallet, signature, timestamp, walletAddress });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/what-if-holdings?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { tokens: [{ tokenAddress, symbol, name, quantity }], positions: [{ key, kind, label, valueUsd }] }
  }, []);

  const simulateSell = useCallback(async (wallet, signature, timestamp, { walletAddress, tokenAddress, quantity }) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/what-if-sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, walletAddress, tokenAddress, quantity }),
    });
    await parseErrorOrThrow(res);
    return res.json();
  }, []);

  const simulateExit = useCallback(async (wallet, signature, timestamp, { walletAddress, positionKey, exitPct, sellToEtn }) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/what-if-exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, walletAddress, positionKey, exitPct, sellToEtn }),
    });
    await parseErrorOrThrow(res);
    return res.json();
  }, []);

  return { getSellableHoldings, simulateSell, simulateExit };
}
