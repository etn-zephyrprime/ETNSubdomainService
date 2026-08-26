import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { usePayment } from "../../hooks/usePayment.js";
import { formatCompact, formatTokenAmount, formatEtnBalance, formatInt, shortHash, isSpamTokenName, formatChartDate } from "../utils/format.js";
import { bucketDailyCounts } from "../utils/history.js";
import { EXPLORER_BASE_URL } from "../config.js";
import NeonButton from "../../components/NeonButton.jsx";
import TileChart from "./TileChart.jsx";

const inputStyle = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
};

// How many pages of transactions/token-transfers to fetch for the "recent activity" charts
// below — Blockscout has no count-over-time endpoint for either, so this derives one from
// whichever items were actually fetched (see utils/history.js). Bounded rather than "fetch
// everything" so a genuinely high-activity address (a contract, an exchange wallet) doesn't mean
// an unbounded number of requests just to draw a chart.
const MAX_HISTORY_PAGES = 5;

async function fetchBoundedPages(fetchFn, address, maxPages) {
  const items = [];
  let nextPageParams = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchFn(address, nextPageParams);
    items.push(...(res.items || []));
    if (!res.next_page_params) break;
    nextPageParams = res.next_page_params;
  }
  return items;
}

const METRICS = [
  { id: "balance", label: "ETN Balance" },
  { id: "transactions", label: "Transactions" },
  { id: "tokenTransfers", label: "Token Transfers" },
];

const HOLDING_CATEGORIES = [
  { id: "tokens", label: "Tokens" },
  { id: "nfts", label: "NFT's" },
];
const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);

// Session-only single wallet lookup (free tier) — accepts either a raw 0x address or a .etn name,
// reusing usePayment.js's existing resolveName() rather than re-implementing name resolution a
// second time. Nothing here is persisted; re-searching starts fresh, same as the brief's "not
// persisted" free-tier spec.
export default function AddressLookup({ initialAddress = null }) {
  const { getAddress, getAddressCounters, getAddressTokenBalances, getAddressCoinBalanceHistory, getAddressTransactions, getAddressTokenTransfers } = useBlockscout();
  const { resolveName } = usePayment();

  const [input, setInput] = useState(initialAddress || "");
  const [resolvedAddress, setResolvedAddress] = useState(initialAddress || null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);

  const [addressInfo, setAddressInfo] = useState(null);
  const [counters, setCounters] = useState(null);
  const [tokenBalances, setTokenBalances] = useState([]);
  const [loadError, setLoadError] = useState(null);

  const [balanceHistory, setBalanceHistory] = useState(null);
  const [txHistory, setTxHistory] = useState(null);
  const [transferHistory, setTransferHistory] = useState(null);
  const [activeMetric, setActiveMetric] = useState("balance");
  const [holdingsCategory, setHoldingsCategory] = useState("tokens");

  const handleLookup = async () => {
    setResolveError(null);
    setAddressInfo(null);
    setLoadError(null);

    const trimmed = input.trim();
    if (!trimmed) return;

    setResolving(true);
    try {
      const address = ethers.isAddress(trimmed) ? trimmed : await resolveName(trimmed);
      setResolvedAddress(address);
    } catch (err) {
      setResolveError(err.message || "Couldn't resolve that address or name");
      setResolvedAddress(null);
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    setBalanceHistory(null);
    setTxHistory(null);
    setTransferHistory(null);
    (async () => {
      try {
        const [info, counterRes, balances] = await Promise.all([
          getAddress(resolvedAddress),
          getAddressCounters(resolvedAddress),
          getAddressTokenBalances(resolvedAddress),
        ]);
        if (cancelled) return;
        setAddressInfo(info);
        setCounters(counterRes);
        setTokenBalances(Array.isArray(balances) ? balances : []);
      } catch (err) {
        console.error("Failed to load address detail:", err);
        if (!cancelled) setLoadError("Couldn't load this wallet's data — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddress, getAddressCounters, getAddressTokenBalances]);

  // Chart data loads separately from (and doesn't block) the core address detail above — each of
  // these is its own set of requests (balance history is one call; tx/transfer history are up to
  // MAX_HISTORY_PAGES each), no reason to make the whole screen wait on all of them together.
  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    getAddressCoinBalanceHistory(resolvedAddress)
      .then((res) => { if (!cancelled) setBalanceHistory(Array.isArray(res?.items) ? res.items : []); })
      .catch((err) => { console.error("Failed to load balance history:", err); if (!cancelled) setBalanceHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressCoinBalanceHistory]);

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    fetchBoundedPages(getAddressTransactions, resolvedAddress, MAX_HISTORY_PAGES)
      .then((items) => { if (!cancelled) setTxHistory(items); })
      .catch((err) => { console.error("Failed to load transaction history:", err); if (!cancelled) setTxHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressTransactions]);

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    fetchBoundedPages(getAddressTokenTransfers, resolvedAddress, MAX_HISTORY_PAGES)
      .then((items) => { if (!cancelled) setTransferHistory(items); })
      .catch((err) => { console.error("Failed to load token transfer history:", err); if (!cancelled) setTransferHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressTokenTransfers]);

  // Each series is `{ label, value }[]` — label is a real date from whichever source backs that
  // metric, threaded through to SparklineChart for its axis labels + hover tooltip.
  const series = useMemo(() => ({
    // No .reverse() here, deliberately — unlike Blockscout's other chart-ish endpoints (stats
    // charts, main-page lists), coin-balance-history-by-day already comes back oldest-first
    // (confirmed live: earliest date first, today's date last). Reversing it was flipping the
    // chart's X-axis backwards (newest-to-oldest, left-to-right).
    balance: balanceHistory
      ? balanceHistory.map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) }))
      : [],
    transactions: txHistory ? bucketDailyCounts(txHistory, "timestamp") : [],
    tokenTransfers: transferHistory ? bucketDailyCounts(transferHistory, "timestamp") : [],
  }), [balanceHistory, txHistory, transferHistory]);

  const chartLoading = { balance: balanceHistory === null, transactions: txHistory === null, tokenTransfers: transferHistory === null }[activeMetric];

  const visibleHoldings = useMemo(() => {
    const wantNft = holdingsCategory === "nfts";
    return tokenBalances.filter((tb) => {
      const isNft = NFT_TOKEN_TYPES.has(tb.token?.type);
      if (isNft !== wantNft) return false;
      return !isSpamTokenName(tb.token?.name);
    });
  }, [tokenBalances, holdingsCategory]);

  const captions = {
    balance: "ETN balance, full history by day",
    transactions: `Transactions per day (last ${Math.min(txHistory?.length ?? 0, 250)} fetched, ${MAX_HISTORY_PAGES} page(s) max)`,
    tokenTransfers: `Token transfers per day (last ${Math.min(transferHistory?.length ?? 0, 250)} fetched, ${MAX_HISTORY_PAGES} page(s) max)`,
  };

  const formatValues = {
    balance: (v) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`,
    transactions: formatInt,
    tokenTransfers: formatInt,
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          placeholder="0x... or a .etn name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLookup(); }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <NeonButton variant="green" onClick={handleLookup} loading={resolving} style={{ padding: "12px 20px" }}>
          Look Up
        </NeonButton>
      </div>

      {resolveError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{resolveError}</div>
      )}
      {loadError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{loadError}</div>
      )}

      {resolvedAddress && addressInfo && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>
              {addressInfo.ens_domain_name || "Wallet"}
            </div>
            <a
              href={`${EXPLORER_BASE_URL}/address/${resolvedAddress}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: mutedLight, fontFamily: "monospace", textDecoration: "none", borderBottom: `1px solid ${border}` }}
            >
              {resolvedAddress}
            </a>
            {addressInfo.is_contract && (
              <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>Contract{addressInfo.is_verified ? " · Verified" : ""}</div>
            )}
          </div>

          <TileChart
            tiles={[
              { id: "balance", label: "ETN Balance", value: `${formatEtnBalance(addressInfo.coin_balance)} ETN` },
              { id: "transactions", label: "Transactions", value: counters ? formatCompact(counters.transactions_count) : "…" },
              { id: "tokenTransfers", label: "Token Transfers", value: counters ? formatCompact(counters.token_transfers_count) : "…" },
            ]}
            activeId={activeMetric}
            onSelect={setActiveMetric}
            data={series[activeMetric]}
            formatValue={formatValues[activeMetric]}
            formatLabel={formatChartDate}
            chartCaption={captions[activeMetric]}
            loading={chartLoading}
          />

          <div style={{ display: "flex", gap: 8, margin: "24px 0 8px" }}>
            {HOLDING_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setHoldingsCategory(c.id)}
                style={{
                  flex: "1 1 100px",
                  padding: "8px 8px",
                  borderRadius: 10,
                  border: `1px solid ${c.id === holdingsCategory ? green : border}`,
                  background: c.id === holdingsCategory ? "rgba(24,187,26,0.12)" : panel2,
                  color: c.id === holdingsCategory ? green : mutedLight,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {visibleHoldings.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>
              {holdingsCategory === "nfts" ? "No NFTs held." : "No token balances."}
            </div>
          ) : (
            visibleHoldings.slice(0, 25).map((tb, i) => (
              <div key={`${tb.token?.address}-${i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}>
                <span style={{ fontSize: 12, color: "#fff" }}>
                  {tb.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{tb.token?.symbol}</span>
                </span>
                <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(tb.value, tb.token?.decimals)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
