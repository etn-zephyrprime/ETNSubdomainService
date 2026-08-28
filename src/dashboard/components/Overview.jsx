import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { green, orange, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { useDashboardStats, reconstructCumulativeTransactions, mergeDailyTransactionCounts } from "../hooks/useDashboardStats.js";
import { useDailyBlockStats } from "../hooks/useDailyBlockStats.js";
import { useHourlyActivity } from "../hooks/useHourlyActivity.js";
import { formatCompact, formatInt, shortHash, timeAgo, formatEtnBalance, formatChartDate } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import TileChart from "./TileChart.jsx";
import EtnPriceChart from "./EtnPriceChart.jsx";
import CalendarHeatmap from "./CalendarHeatmap.jsx";
import WeekHourHeatmap from "./WeekHourHeatmap.jsx";
import BlockTimeConstant from "./BlockTimeConstant.jsx";

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
  { id: "txsToday", label: "Txs (Last 7 Days)", formatValue: formatInt },
];

const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_HOURS = 7 * 24;
// Require most of the 7-day window's hourly buckets to be present before showing the tile's
// headline total — hourlyActivityCache.js typically catches up well under an hour after a fresh
// deploy, but showing a partial sum as if it were the real 7-day total during that window would
// read as a wrong number, not an honestly-thin one. Same "null until there's enough real data"
// discipline the old 24h tile already used.
const MIN_HOURS_FOR_7D_TOTAL = Math.round(SEVEN_DAYS_HOURS * 0.85);

export default function Overview() {
  const { getStats, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks } = useBlockscout();
  const { getSnapshots } = useDashboardStats();
  const { getDailyBlockStats } = useDailyBlockStats();
  const { getHourlyActivity } = useHourlyActivity();

  const [stats, setStats] = useState(null);
  const [txChart, setTxChart] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [dailyBlockStats, setDailyBlockStats] = useState(null);
  const [hourlyActivity, setHourlyActivity] = useState(null);
  const [indexingStatus, setIndexingStatus] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [activeMetric, setActiveMetric] = useState("totalTx");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statsRes, txChartRes, indexingRes, txRes, blocksRes, snapshotsRes, dailyBlockStatsRes, hourlyActivityRes] = await Promise.all([
          getStats(),
          getTransactionsChart(),
          getIndexingStatus(),
          getRecentTransactions(),
          getRecentBlocks(),
          getSnapshots(),
          getDailyBlockStats(),
          getHourlyActivity(),
        ]);
        if (cancelled) return;
        setStats(statsRes);
        setTxChart(txChartRes);
        setIndexingStatus(indexingRes);
        setTransactions(Array.isArray(txRes) ? txRes.slice(0, 8) : []);
        setBlocks(Array.isArray(blocksRes) ? blocksRes.slice(0, 8) : []);
        setSnapshots(snapshotsRes);
        setDailyBlockStats(dailyBlockStatsRes?.days || {});
        setHourlyActivity(hourlyActivityRes?.hours || {});
      } catch (err) {
        console.error("Failed to load network overview:", err);
        if (!cancelled) setLoadError("Couldn't load network data — try refreshing shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [getStats, getTransactionsChart, getIndexingStatus, getRecentTransactions, getRecentBlocks, getSnapshots, getDailyBlockStats, getHourlyActivity]);

  // Each series is `{ label, value }[]` — label is a real date/timestamp from whichever source
  // backs that metric, threaded through to SparklineChart for its axis labels + hover tooltip.
  const series = useMemo(() => {
    // Real daily counts, merged from Blockscout's own 31-day chart plus dailyBlockStatsCache.js's
    // independently-scanned extension further back — see mergeDailyTransactionCounts's own
    // comment. Grows from 31 real days toward a full 90 as that cache's backfill progresses.
    const totalTx = stats && txChart
      ? reconstructCumulativeTransactions(mergeDailyTransactionCounts(txChart.chart_data, dailyBlockStats), Number(stats.total_transactions))
      : [];
    const totalAddresses = snapshots.map((s) => ({ label: s.timestamp, value: s.totalAddresses }));
    const avgBlockTime = snapshots.map((s) => ({ label: s.timestamp, value: s.averageBlockTimeMs / 1000 }));
    const gasPrice = snapshots.map((s) => ({ label: s.timestamp, value: s.gasPriceAverage }));

    return { totalTx, totalAddresses, avgBlockTime, gasPrice };
  }, [stats, txChart, snapshots, dailyBlockStats]);

  // 7-day headline total for the Txs tile — sums hourlyActivityCache.js's real per-hour counts
  // across the trailing 168 hours. null (tile shows "…") until most of that window is actually
  // backfilled, same "don't show a partial sum as if it were the real total" discipline the old
  // 24h tile used against dashboardStatsCache.js's snapshots.
  const txsLast7d = useMemo(() => {
    if (!hourlyActivity) return null;
    const today = new Date();
    let sum = 0;
    let covered = 0;
    for (let i = 0; i < SEVEN_DAYS_HOURS; i++) {
      const d = new Date(today.getTime() - i * ONE_HOUR_MS);
      const key = `${d.toISOString().slice(0, 10)}T${String(d.getUTCHours()).padStart(2, "0")}`;
      const entry = hourlyActivity[key];
      if (entry) {
        sum += entry.txCount;
        covered++;
      }
    }
    return covered >= MIN_HOURS_FOR_7D_TOTAL ? sum : null;
  }, [hourlyActivity]);

  // Whether Avg Block Time has shown any real variation yet — checked against every real value
  // this app actually has: dashboardStatsCache.js's hourly snapshots (each one reads Blockscout's
  // own average_block_time live) plus this page's own fresh /stats call. Currently always true
  // (5.000s in every real value seen), but this is a live check against live Blockscout data every
  // time it runs, not a hardcoded assumption — if the network's block time ever actually changes,
  // this flips false the next hour a snapshot picks it up, and the tile switches to a real trend
  // line automatically instead of continuing to claim it's constant.
  const blockTimeIsConstant = useMemo(() => {
    if (!stats) return true; // unknown yet — default to the clean view; re-checked once stats loads
    const values = new Set(snapshots.map((s) => s.averageBlockTimeMs));
    values.add(Number(stats.average_block_time));
    return values.size <= 1;
  }, [stats, snapshots]);

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
        case "txsToday": return txsLast7d != null ? formatInt(txsLast7d) : "…";
        default: return "…";
      }
    })();
    return { id: m.id, label: m.label, value };
  });

  const dailyCoverageDays = series.totalTx.length;
  const validatorDaysTracked = dailyBlockStats ? Object.keys(dailyBlockStats).length : 0;
  const hourlyCoverageHours = hourlyActivity ? Object.keys(hourlyActivity).length : 0;

  const captions = {
    // Real daily counts throughout, no reconstruction-window guessing — see
    // mergeDailyTransactionCounts's comment for why this starts at 31 real days (Blockscout's own
    // cap) and grows toward 90 as dailyBlockStatsCache.js's independent scan backfills further back.
    totalTx: `Total transactions, real daily counts — last ${dailyCoverageDays} day${dailyCoverageDays === 1 ? "" : "s"}${dailyCoverageDays < 90 ? " (extending toward 90 as history backfills)" : ""}`,
    // No real historical source exists for this anywhere (not Blockscout, not reconstructable
    // from raw blocks — see the PR that added this caption for the full explanation) — it can
    // only ever be "however many hourly snapshots this backend has collected so far", growing by
    // one real hour every hour, same as the day it was first built.
    totalAddresses: snapshots.length > 0 ? `Total addresses — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    totalBlocks: `Daily tx-count heatmap, last 90 days (darker = fewer, brighter = more) — ${validatorDaysTracked} day(s) of real data so far. Hover a day for its validator breakdown.`,
    avgBlockTime: blockTimeIsConstant
      ? "Block time — every real hourly reading from Blockscout has been identical so far (see below)"
      : `Average block time (seconds) — ${snapshots.length} hourly snapshot(s) collected so far`,
    gasPrice: snapshots.length > 0 ? `Average gas price (gwei) — ${snapshots.length} hourly snapshot(s) collected so far` : "Collecting hourly snapshots — check back soon",
    txsToday: `Transactions per hour, last 7 days (darker = fewer, brighter = more) — ${hourlyCoverageHours} hour(s) of real data so far. Hover a cell for ETN transferred.`,
  };

  const activeFormatValue = METRICS.find((m) => m.id === activeMetric).formatValue;
  const renderChart = activeMetric === "totalBlocks"
    ? () => <CalendarHeatmap days={dailyBlockStats} />
    : activeMetric === "txsToday"
    ? () => <WeekHourHeatmap hours={hourlyActivity} />
    : activeMetric === "avgBlockTime" && stats && blockTimeIsConstant
    ? () => <BlockTimeConstant blockTimeSeconds={stats.average_block_time / 1000} />
    : null;

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
        renderChart={renderChart}
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
