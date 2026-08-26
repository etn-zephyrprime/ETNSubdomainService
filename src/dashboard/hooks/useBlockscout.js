import { useCallback } from "react";
import { BLOCKSCOUT_API_BASE } from "../config.js";

async function fetchJson(path) {
  const res = await fetch(`${BLOCKSCOUT_API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Blockscout ${path} returned ${res.status}`);
  }
  return res.json();
}

// Thin, one-function-per-endpoint wrapper around Electroneum's public Blockscout v2 API — no
// caching/state here, each screen owns its own loading/error state the same way the rest of this
// app's hooks do (useOwnedNames.js, useActivatedDomains.js, etc.), just against a third-party API
// instead of this app's own R2 caches.
export function useBlockscout() {
  const getStats = useCallback(() => fetchJson("/stats"), []);
  const getMarketChart = useCallback(() => fetchJson("/stats/charts/market"), []);
  const getTransactionsChart = useCallback(() => fetchJson("/stats/charts/transactions"), []);
  const getIndexingStatus = useCallback(() => fetchJson("/main-page/indexing-status"), []);
  const getRecentTransactions = useCallback(() => fetchJson("/main-page/transactions"), []);
  const getRecentBlocks = useCallback(() => fetchJson("/main-page/blocks"), []);

  const getTokens = useCallback((nextPageParams = null) => {
    const query = nextPageParams
      ? `?${new URLSearchParams(nextPageParams).toString()}`
      : "";
    return fetchJson(`/tokens${query}`);
  }, []);
  const getToken = useCallback((address) => fetchJson(`/tokens/${address}`), []);
  const getTokenHolders = useCallback((address) => fetchJson(`/tokens/${address}/holders`), []);

  const getAddress = useCallback((address) => fetchJson(`/addresses/${address}`), []);
  const getAddressCounters = useCallback((address) => fetchJson(`/addresses/${address}/counters`), []);
  const getAddressTokenBalances = useCallback((address) => fetchJson(`/addresses/${address}/token-balances`), []);
  const getAddressTransactions = useCallback((address) => fetchJson(`/addresses/${address}/transactions`), []);

  return {
    getStats,
    getMarketChart,
    getTransactionsChart,
    getIndexingStatus,
    getRecentTransactions,
    getRecentBlocks,
    getTokens,
    getToken,
    getTokenHolders,
    getAddress,
    getAddressCounters,
    getAddressTokenBalances,
    getAddressTransactions,
  };
}
