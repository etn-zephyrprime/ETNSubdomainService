import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { green, orange, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { useDashboardStats, reconstructCumulativeTransactions } from "../hooks/useDashboardStats.js";
import { formatCompact, formatInt, shortHash, timeAgo, formatEtnBalance, formatChartDate } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import TileChart from "./TileChart.jsx";
import EtnPriceChart from "./EtnPriceChart.jsx";

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

// The 6 metrics the shared Overview chart can show, driven by clicking a tile, each with its own
// value formatter (chart Y-axis + tooltip) — "totalTx" is reconstructed from real existing daily
// data (rich immediately); the rest come from dashboardStatsCache.js's hourly snapshots (thin at
// first, growing an hour richer every hour — there's no Blockscout history to backfill from, see
// that file's header comment).
const METRICS = [
  { id: "totalTx", label: "Total Transactions", formatValue: formatCompact },
  { id: "totalAddresses", label: "Total Addresses", formatValue: formatCompact },
  { id: "totalBlocks", label: "Total Blocks", formatValue: formatCompact },
  { id: "avgBlockTime", label: "Avg Block Time", formatValue: (v) => `${v.toFixed(1)}s` },
  { id: "gasPrice", label: "Gas Price", formatValue: (v) => `${v.toFixed(2)} gwei` },
  { id: "txsToday", label: "Txs (Last 24h)", formatValue: formatInt },
];

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export default function Overview() {
  const { getStats, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks } = useBlockscout();
  const { getSnapshots } = useDashboardStats();

  const [stats, setStats] = useState(null);
  const [txChart, setTxChart] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [indexingStatus, setIndexingStatus] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [activeMetric, setActiveMetric] = useState("totalTx");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statsRes, txChartRes, indexingRes, txRes, blocksRes, snapshotsRes] = await Promise.all([
          getStats(),
          getTransactionsChart(),
          getIndexingStatus(),
          getRecentTransactions(),
          getRecentBlocks(),
          getSnapshots(),
        ]);
        if (cancelled) return;
        setStats(statsRes);
        setTxChart(txChartRes);
        setIndexingStatus(indexingRes);
        setTransactions(Array.isArray(txRes) ? txRes.slice(0, 8) : []);
        setBlocks(Array.isArray(blocksRes) ? blocksRes.slice(0, 8) : []);
        setSnapshots(snapshotsRes);
      } catch (err) {
        console.error("Failed to load network overview:", err);
        if (!cancelled) setLoadError("Couldn't load network data — try refreshing shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [getStats, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks, getSnapshots]);

  // Each series is `{ label, value }[]` — label is a real date/timestamp from whichever source
  // backs that metric, threaded through to SparklineChart for its axis labels + hover tooltip.
  const series = useMemo(() => {
    const totalTx = stats && txChart
      ? reconstructCumulativeTransactions(txChart.chart_data, Number(stats.total_transactions)).slice(-90)
      : [];
    const totalAddresses = snapshots.map((s) => ({ label: s.timestamp, value: s.totalAddresses }));
    const totalBlocks = snapshots.map((s) => ({ label: s.timestamp, value: s.totalBlocks }));
    const avgBlockTime = snapshots.map((s) => ({ label: s.timestamp, value: s.averageBlockTimeMs / 1000 }));
    const gasPrice = snapshots.map((s) => ({ label: s.timestamp, value: s.gasPriceAverage }));
    // A rolling last-24-hours window, not "since UTC midnight" — two reasons. Confirmed live
    // that Blockscout's own "transactions_today" field can get stuck for an entire day (frozen
    // at the same value for 19+ hours while total_transactions kept growing normally), so this
    // no longer reads that field at all; transactionsThisHour is now a delta between this
    // backend's own consecutive snapshots instead (see dashboardStatsCache.js). Separately, even
    // when Blockscout's field worked fine, "today" meant the chart only had 1 real hour of bars
    // right after UTC midnight, growing to 24 by end of day — a rolling window is always a
    // consistent 24 hours regardless of what time it is.
    const cutoffMs = Date.now() - ONE_DAY_MS;
    const txsToday = snapshots
      .filter((s) => new Date(s.timestamp).getTime() >= cutoffMs)
      .map((s) => ({ label: s.timestamp, value: s.transactionsThisHour }));

    return { totalTx, totalAddresses, totalBlocks, avgBlockTime, gasPrice, txsToday };
  }, [stats, txChart, snapshots]);

  // Tile headline value — same rolling-24h reasoning as the chart above, not stats.transactions_today
  // (the field confirmed stuck upstream). null until there's at least one snapshot old enough to
  // diff against (same "thin at first" cold-start behavior as the other snapshot-backed tiles).
  const txsLast24h = useMemo(() => {
    if (snapshots.length === 0) return null;
    const latest = snapshots[snapshots.length - 1];
    const cutoffMs = Date.now() - ONE_DAY_MS;
    const oldestInWindow = snapshots.find((s) => new Date(s.timestamp).getTime() >= cutoffMs) || snapshots[0];
    if (oldestInWindow === latest) return null;
    return Math.max(0, latest.totalTransactions - oldestInWindow.totalTransactions);
  }, [snapshots]);

  if (loadError) {
    return <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{loadError}</div>;
  }

  const tiles = METRICS.map((m) => {
    const value = (() => {
      if (!stats) return "…";
      switch (m.id) {
        case "totalTx": return formatCompact(stats.total_transactions);
        case "totalAddresses": return formatCompact(stats.total_addresses);
        case "totalBlocks": return formatCompact(stats.total_blocks);
        case "avgBlockTime": return `${(stats.average_block_time / 1000).toFixed(1)}s`;
        case "gasPrice": return `${stats.gas_prices?.average} gwei`;
        case "txsToday": return txsLast24h != null ? formatInt(txsLast24h) : "…";
        default: return "…";
      }
    })();
    return { id: m.id, label: m.label, value };
  });

  const captions = {
    totalTx: "Total transactions, reconstructed from real daily activity (last 90 days)",
    totalAddresses: snapshots.length > 0 ? `Total addresses — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    totalBlocks: snapshots.length > 0 ? `Total blocks — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    avgBlockTime: snapshots.length > 0 ? `Average block time (seconds) — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    gasPrice: snapshots.length > 0 ? `Average gas price (gwei) — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    txsToday: "Transactions per hour, rolling last 24 hours",
  };

  const activeFormatValue = METRICS.find((m) => m.id === activeMetric).formatValue;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <IndexingBadge status={indexingStatus} />
      </div>

      <EtnPriceChart />

      <TileChart
        tiles={tiles}
        activeId={activeMetric}
        onSelect={setActiveMetric}
        data={series[activeMetric] || []}
        formatValue={activeFormatValue}
        formatLabel={formatChartDate}
        chartCaption={captions[activeMetric]}
        loading={!stats}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 24 }}>
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
