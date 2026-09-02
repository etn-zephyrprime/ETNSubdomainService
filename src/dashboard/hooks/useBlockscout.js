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

  // Chain-wide, paginated — unlike the old /main-page/transactions and /main-page/blocks (small
  // fixed snapshots with no next_page_params at all: fine for "what's happening right now", no way
  // to ever show more than that). Same nextPageParams-cursor shape as getAddressTransactions/
  // getAddressTokenTransfers below, just without an address scoping it — powers Overview.jsx's
  // Recent Transactions/Recent Blocks (and their "Show more") and its Top Transactions by Volume.
  const getTransactions = useCallback((nextPageParams = null) => {
    const query = nextPageParams ? `?${new URLSearchParams(nextPageParams).toString()}` : "";
    return fetchJson(`/transactions${query}`);
  }, []);
  const getBlocks = useCallback((nextPageParams = null) => {
    const params = { type: "block", ...(nextPageParams || {}) };
    return fetchJson(`/blocks?${new URLSearchParams(params).toString()}`);
  }, []);
  // Powers Overview.jsx's "ETN moved" aggregate per row in Recent Blocks — the block list/detail
  // endpoints above never include a block-level value total (confirmed live: a /blocks item's
  // fields are all gas/fee/reward related, nothing sums the native value actually transferred), so
  // this is the only way to get it: fetch every tx in the block and sum `value` client-side.
  // Confirmed live a real block's txs come back in one page (next_page_params: null) even at ~30
  // txs, but nextPageParams is still threaded through in case a busier block ever paginates.
  const getBlockTransactions = useCallback((height, nextPageParams = null) => {
    const query = nextPageParams ? `?${new URLSearchParams(nextPageParams).toString()}` : "";
    return fetchJson(`/blocks/${height}/transactions${query}`);
  }, []);

  // `type` is a Blockscout token type filter, e.g. "ERC-20" or "ERC-721,ERC-1155" — confirmed
  // live that the API supports both single and comma-separated multi-type filtering server-side,
  // so the Tokens/NFT's split (TokenLeaderboard.jsx) doesn't need to fetch everything and filter
  // client-side.
  const getTokens = useCallback((type = null, nextPageParams = null) => {
    const params = { ...(type ? { type } : {}), ...(nextPageParams || {}) };
    const query = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : "";
    return fetchJson(`/tokens${query}`);
  }, []);
  const getToken = useCallback((address) => fetchJson(`/tokens/${address}`), []);
  const getTokenHolders = useCallback((address) => fetchJson(`/tokens/${address}/holders`), []);

  const getAddress = useCallback((address) => fetchJson(`/addresses/${address}`), []);
  const getAddressCounters = useCallback((address) => fetchJson(`/addresses/${address}/counters`), []);
  const getAddressTokenBalances = useCallback((address) => fetchJson(`/addresses/${address}/token-balances`), []);
  const getAddressCoinBalanceHistory = useCallback((address) => fetchJson(`/addresses/${address}/coin-balance-history-by-day`), []);

  const getAddressTransactions = useCallback((address, nextPageParams = null) => {
    const query = nextPageParams ? `?${new URLSearchParams(nextPageParams).toString()}` : "";
    return fetchJson(`/addresses/${address}/transactions${query}`);
  }, []);
  const getAddressTokenTransfers = useCallback((address, nextPageParams = null) => {
    const query = nextPageParams ? `?${new URLSearchParams(nextPageParams).toString()}` : "";
    return fetchJson(`/addresses/${address}/token-transfers${query}`);
  }, []);

  return {
    getStats,
    getMarketChart,
    getTransactionsChart,
    getIndexingStatus,
    getTransactions,
    getBlocks,
    getBlockTransactions,
    getTokens,
    getToken,
    getTokenHolders,
    getAddress,
    getAddressCounters,
    getAddressTokenBalances,
    getAddressCoinBalanceHistory,
    getAddressTransactions,
    getAddressTokenTransfers,
  };
}
