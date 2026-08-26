import React, { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { green, orange, mutedLight, muted, panel2, border, error as errorColor } from "../../styles/theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { formatCompact, formatInt, shortHash, timeAgo, formatEtnBalance } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import StatCard from "./StatCard.jsx";
import SparklineChart from "./SparklineChart.jsx";

function IndexingBadge({ status }) {
  if (!status) return null;
  const isCaughtUp = status.finished_indexing;
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 14px",
      borderRadius: 10,
      background: panel2,
      border: `1px solid ${isCaughtUp ? green : orange}`,
      fontSize: 12,
      fontWeight: 700,
      color: isCaughtUp ? green : orange,
    }}>
      {isCaughtUp ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      {isCaughtUp
        ? "Fully indexed"
        : `Indexing — ${(Number(status.indexed_blocks_ratio) * 100).toFixed(1)}% of blocks`}
    </div>
  );
}

function TxRow({ tx }) {
  const label = tx.from?.ens_domain_name || shortHash(tx.from?.hash);
  return (
    <a
      href={`${EXPLORER_BASE_URL}/tx/${tx.hash}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none", gap: 10 }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#fff", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {shortHash(tx.hash)}
        </div>
        <div style={{ fontSize: 11, color: mutedLight, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {tx.method || "transfer"} · from {label}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatEtnBalance(tx.value)} ETN</div>
        <div style={{ fontSize: 10, color: muted }}>{timeAgo(tx.timestamp)}</div>
      </div>
    </a>
  );
}

function BlockRow({ block }) {
  return (
    <a
      href={`${EXPLORER_BASE_URL}/block/${block.height}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none", gap: 10 }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>#{formatInt(block.height)}</div>
        <div style={{ fontSize: 11, color: mutedLight }}>
          {block.transaction_count} tx{block.transaction_count === 1 ? "" : "s"} · miner {shortHash(block.miner?.hash)}
        </div>
      </div>
      <div style={{ fontSize: 10, color: muted, flexShrink: 0 }}>{timeAgo(block.timestamp)}</div>
    </a>
  );
}

export default function Overview() {
  const { getStats, getMarketChart, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks } = useBlockscout();

  const [stats, setStats] = useState(null);
  const [marketChart, setMarketChart] = useState(null);
  const [txChart, setTxChart] = useState(null);
  const [indexingStatus, setIndexingStatus] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statsRes, marketRes, txChartRes, indexingRes, txRes, blocksRes] = await Promise.all([
          getStats(),
          getMarketChart(),
          getTransactionsChart(),
          getIndexingStatus(),
          getRecentTransactions(),
          getRecentBlocks(),
        ]);
        if (cancelled) return;
        setStats(statsRes);
        setMarketChart(marketRes);
        setTxChart(txChartRes);
        setIndexingStatus(indexingRes);
        setTransactions(Array.isArray(txRes) ? txRes.slice(0, 8) : []);
        setBlocks(Array.isArray(blocksRes) ? blocksRes.slice(0, 8) : []);
      } catch (err) {
        console.error("Failed to load network overview:", err);
        if (!cancelled) setLoadError("Couldn't load network data — try refreshing shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [getStats, getMarketChart, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks]);

  if (loadError) {
    return <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{loadError}</div>;
  }

  // Chart endpoints return oldest-last; charts read more naturally oldest-first, left to right.
  const marketPrices = marketChart
    ? [...marketChart.chart_data].reverse().map((d) => (d.closing_price != null ? Number(d.closing_price) : null))
    : [];
  const txCounts = txChart
    ? [...txChart.chart_data].reverse().map((d) => (d.transaction_count != null ? Number(d.transaction_count) : null))
    : [];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <IndexingBadge status={indexingStatus} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 24 }}>
        <StatCard label="ETN Price" value={stats ? `$${Number(stats.coin_price).toFixed(6)}` : "…"} />
        <StatCard label="Market Cap" value={stats ? `$${formatCompact(stats.market_cap)}` : "…"} />
        <StatCard label="Total Transactions" value={stats ? formatCompact(stats.total_transactions) : "…"} />
        <StatCard label="Total Addresses" value={stats ? formatCompact(stats.total_addresses) : "…"} />
        <StatCard label="Total Blocks" value={stats ? formatCompact(stats.total_blocks) : "…"} />
        <StatCard label="Avg Block Time" value={stats ? `${(stats.average_block_time / 1000).toFixed(1)}s` : "…"} />
        <StatCard label="Gas Price" value={stats ? `${stats.gas_prices?.average} gwei` : "…"} />
        <StatCard label="Txs Today" value={stats ? formatInt(stats.transactions_today) : "…"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 24 }}>
        <StatCard label="Market Cap (30d)" value="">
          <SparklineChart points={marketPrices.slice(-30)} />
        </StatCard>
        <StatCard label="Daily Transactions (30d)" value="">
          <SparklineChart points={txCounts.slice(-30)} />
        </StatCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Recent Transactions
          </div>
          {transactions.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>Loading…</div>
          ) : (
            transactions.map((tx) => <TxRow key={tx.hash} tx={tx} />)
          )}
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Recent Blocks
          </div>
          {blocks.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>Loading…</div>
          ) : (
            blocks.map((block) => <BlockRow key={block.hash} block={block} />)
          )}
        </div>
      </div>
    </div>
  );
}
