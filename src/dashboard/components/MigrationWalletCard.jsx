import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, blue, muted, mutedLight, panel2, border, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import CornerBrackets from "./CornerBrackets.jsx";
import SparklineChart from "./SparklineChart.jsx";
import { useMigrationWalletHistory } from "../hooks/useMigrationWalletHistory.js";
import { formatCompact, formatChartDate, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { MIGRATION_WALLET_ADDRESS } from "../utils/migrationWallet.js";

const sectionLabel = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted };
const POLL_INTERVAL_MS = 300000; // backend refreshes every 15 min — this just needs to notice a fresh publish reasonably soon after

function etn(wei) {
  try {
    return `${parseFloat(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN`;
  } catch {
    return "—";
  }
}

// A dedicated watch on one specific wallet (see backend/utils/migrationWalletTracker.js's own
// header comment for exactly why: a ~2.19B ETN balance appeared on it in a single non-transactional
// event, confirmed via Blockscout's own coin-balance-history — nothing about it has moved since).
// Sits on the ETN Bridge tab since that's the context it surfaced in, though this wallet isn't the
// bridge contract itself — just an address of interest flagged from that same migration activity.
export default function MigrationWalletCard() {
  const { getMigrationWalletHistory } = useMigrationWalletHistory();
  const [data, setData] = useState(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getMigrationWalletHistory().then((res) => { if (!cancelled) setData(res); });
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getMigrationWalletHistory]);

  const chartData = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .map((p) => {
        let value;
        try {
          value = parseFloat(ethers.formatEther(p.balance));
        } catch {
          value = null;
        }
        return { label: p.date, value: Number.isFinite(value) ? value : null };
      })
      .filter((p) => p.value !== null);
  }, [data]);

  const hasMoved = (data?.transactions?.length || 0) > 0;

  return (
    <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
      <CornerBrackets color={green} />
      <div style={{ ...sectionLabel, marginBottom: 4 }}>Watched Wallet</div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 14, lineHeight: 1.5 }}>
        <a href={`${EXPLORER_BASE_URL}/address/${MIGRATION_WALLET_ADDRESS}`} target="_blank" rel="noreferrer" style={{ color: blue, fontFamily: monoFont }}>
          {shortHash(MIGRATION_WALLET_ADDRESS, 8)}
        </a>{" "}
        — flagged after a large ETN balance appeared on it in a single event outside ordinary transaction activity, consistent with a chain
        migration credit rather than a transfer. Tracked here specifically to notice if/when it ever moves.
      </div>

      {data === undefined ? (
        <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
      ) : data.balance === null ? (
        <div style={{ fontSize: 12, color: mutedLight, padding: "14px 0" }}>No data published yet — check back shortly.</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
            <StatCard
              label="Current Balance"
              value={<><TokenLogo address="NATIVE" label="ETN" size={20} spacing={7} />{formatCompact(parseFloat(ethers.formatEther(data.balance)))} ETN</>}
              sub={etn(data.balance)}
            />
            {data.migrationEvent && (
              <StatCard
                label="Credited"
                value={etn(data.migrationEvent.deltaWei)}
                sub={
                  <a href={`${EXPLORER_BASE_URL}/block/${data.migrationEvent.blockNumber}`} target="_blank" rel="noreferrer" style={{ color: blue }}>
                    Block {data.migrationEvent.blockNumber.toLocaleString()} · {timeAgo(data.migrationEvent.timestamp)}
                  </a>
                }
              />
            )}
            <StatCard
              label="Activity Since"
              value={hasMoved ? `${data.transactions.length} transaction${data.transactions.length === 1 ? "" : "s"}` : "None"}
              sub={hasMoved ? "See below" : "Balance unchanged since it was credited"}
            />
          </div>

          {chartData.length >= 2 ? (
            <SparklineChart data={chartData} height={120} formatValue={(v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN`} formatLabel={formatChartDate} />
          ) : (
            <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: muted }}>
              Not enough history yet for a trend line.
            </div>
          )}

          {hasMoved && (
            <div style={{ marginTop: 16 }}>
              <div style={{ ...sectionLabel, marginBottom: 8, fontSize: 10 }}>Recent Activity</div>
              {data.transactions.map((tx) => (
                <a
                  key={tx.hash}
                  href={`${EXPLORER_BASE_URL}/tx/${tx.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
                >
                  <div style={{ fontSize: 11, color: mutedLight, fontFamily: monoFont }}>
                    {shortHash(tx.from)} → {shortHash(tx.to)}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, color: green, fontWeight: 700 }}>{etn(tx.value)}</div>
                    <div style={{ fontSize: 10, color: muted }}>{timeAgo(tx.timestamp)}</div>
                  </div>
                </a>
              ))}
            </div>
          )}

          {data.updatedAt && <div style={{ fontSize: 10, color: muted, marginTop: 10 }}>Updated {timeAgo(data.updatedAt)}</div>}
        </>
      )}
    </div>
  );
}
