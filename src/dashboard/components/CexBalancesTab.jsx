import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, mutedLight, muted, panel2, border, error as errorColor, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import CornerBrackets from "./CornerBrackets.jsx";
import SparklineChart from "./SparklineChart.jsx";
import { useCexBalanceHistory } from "../hooks/useCexBalanceHistory.js";
import { formatEtnBalance, formatChartDate, shortHash, timeAgo } from "../utils/format.js";

const sectionLabelStyle = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };
const selectStyle = {
  padding: "8px 12px",
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontFamily: monoFont,
  fontSize: 12,
  fontWeight: 600,
  outline: "none",
};

// Re-polls the published cache periodically — backend/utils/cexBalanceHistory.js itself only
// refreshes daily by default, so this just needs to be frequent enough to pick up a fresh publish
// shortly after it happens, same reasoning/cadence as TeamWalletsTab.jsx's own poll.
const POLL_INTERVAL_MS = 60000;

function balanceOf(entry) {
  try {
    return BigInt(entry.balance || "0");
  } catch {
    return 0n;
  }
}

function formatValue(v) {
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;
}

// Free-tier tab tracking every known CEX/bridge address (see backend/db/cexAddresses.js) — a
// combined ETN balance chart over the last ~12 months, plus each address's own current balance.
// Backed entirely by backend/utils/cexBalanceHistory.js's R2-published snapshot
// (useCexBalanceHistory.js) — nothing here talks to Blockscout directly, same reasoning as every
// other cache-backed tab on this dashboard (TeamWalletsTab.jsx, EtnBridgeTab.jsx).
//
// Same "manually-maintained list, not a live on-chain classification" honesty as cex_addresses.js's
// own header comment — an address only shows up here once someone's added it via
// scripts/addCexAddress.js, and despite the table's name it can include a known bridge contract too,
// not exclusively exchanges; each row's own `label` says what it actually is.
export default function CexBalancesTab({ onSelectAddress }) {
  const { getCexBalanceHistory } = useCexBalanceHistory();

  const [series, setSeries] = useState(null); // null = loading, [] = loaded but empty
  const [addresses, setAddresses] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Which single line the chart/stats below show — "combined" (the default) or one specific
  // address. One line at a time, not every address toggled on at once: with more than a couple of
  // addresses a fully multi-line chart reads as noise, not a comparison — a dropdown to swap which
  // one you're looking at (same pattern as CoreTierPnl.jsx's own token filter) is the more usable
  // way to answer "who's actually reducing their ETN" one exchange at a time.
  const [selected, setSelected] = useState("combined");

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      getCexBalanceHistory()
        .then((res) => {
          if (cancelled) return;
          setSeries(res.series);
          setAddresses(res.addresses);
          setUpdatedAt(res.updatedAt);
          setLoadError(null);
        })
        .catch((err) => {
          console.error("Failed to load CEX balance history:", err);
          if (!cancelled) setLoadError("Couldn't load CEX balance data — try again shortly.");
        });
    };

    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getCexBalanceHistory]);

  // Grouped by label, not a flat list — several addresses commonly share one CEX (KuCoin alone has
  // four: two hot wallets, a Vault contract, and its proxy), so a flat dropdown quickly becomes hard
  // to scan. Sorted alphabetically so the group order stays stable as addresses are added over time.
  const groupedAddresses = useMemo(() => {
    const byLabel = new Map();
    for (const a of addresses) {
      if (!byLabel.has(a.label)) byLabel.set(a.label, []);
      byLabel.get(a.label).push(a);
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [addresses]);

  // Three kinds of selection: "combined" (every tracked address), "cex:<label>" (every address
  // sharing one CEX's label — offered only when that CEX has more than one, e.g. "All KuCoin"), or
  // one specific address. Self-healing the same way CoreTierPnl.jsx's own token filter is: if the
  // selected address/label ever vanishes (a relabel, a fetch that dropped it this cycle), this
  // quietly falls back to "combined" instead of showing a blank chart for something no longer in scope.
  const isValidSelection = (sel) => {
    if (sel === "combined") return true;
    if (sel.startsWith("cex:")) return addresses.some((a) => a.label === sel.slice(4));
    return addresses.some((a) => a.address === sel);
  };
  const resolvedSelected = isValidSelection(selected) ? selected : "combined";

  let selectedSeries;
  let selectedLabel;
  if (resolvedSelected === "combined") {
    selectedSeries = series;
    selectedLabel = "Combined";
  } else if (resolvedSelected.startsWith("cex:")) {
    const label = resolvedSelected.slice(4);
    const group = addresses.filter((a) => a.label === label);
    selectedLabel = label;
    // Every address's own `series` shares the exact same date range, in the exact same order (see
    // cexBalanceHistory.js's own dateRange) — safe to sum by index rather than re-matching on date.
    const dates = group[0]?.series?.map((p) => p.date) || [];
    selectedSeries = dates.map((date, i) => ({
      date,
      balance: group.reduce((sum, a) => sum + BigInt(a.series?.[i]?.balance ?? "0"), 0n).toString(),
    }));
  } else {
    const match = addresses.find((a) => a.address === resolvedSelected);
    selectedSeries = match?.series;
    selectedLabel = match?.label;
  }

  const chartData = useMemo(() => {
    if (!Array.isArray(selectedSeries)) return [];
    return selectedSeries
      .map((p) => {
        let value;
        try {
          value = parseFloat(ethers.formatEther(p.totalBalance ?? p.balance));
        } catch {
          value = null;
        }
        return { label: p.date, value: Number.isFinite(value) ? value : null };
      })
      .filter((p) => p.value !== null);
  }, [selectedSeries]);

  const chartStats = useMemo(() => {
    if (chartData.length === 0) return null;
    const values = chartData.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    return {
      current,
      high: Math.max(...values),
      low: Math.min(...values),
      changePct: first ? ((current - first) / first) * 100 : 0,
    };
  }, [chartData]);

  const totalBalanceWei = addresses.reduce((sum, a) => sum + balanceOf(a), 0n);
  const sortedAddresses = [...addresses].sort((a, b) => {
    const diff = balanceOf(b) - balanceOf(a);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });

  return (
    <div>
      <style>{`.dash-cex-row{transition:border-color .15s ease,background .15s ease;} .dash-cex-row:hover,.dash-cex-row:focus-visible{border-bottom-color:${green};}`}</style>

      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        Known exchange (and other confirmed non-personal counterparty, e.g. a bridge) wallets on Electroneum — a
        manually-maintained list, not a live on-chain classification. {addresses.length} address{addresses.length === 1 ? "" : "es"} tracked.
      </div>

      {loadError && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>{loadError}</div>}

      <div style={{ marginBottom: 24 }}>
        <StatCard
          label="Combined CEX ETN Balance"
          value={series === null ? "Loading…" : <><TokenLogo address="NATIVE" label="ETN" size={22} spacing={8} />{formatEtnBalance(totalBalanceWei)} ETN</>}
          sub={updatedAt ? `Updated ${timeAgo(updatedAt)}` : undefined}
        />
      </div>

      <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
        <CornerBrackets color={green} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ ...sectionLabelStyle, marginBottom: 0 }}>
            <TokenLogo address="NATIVE" label="ETN" size={16} spacing={7} />{selectedLabel} ETN Balance — Rolling 12 Months
          </div>
          {addresses.length > 0 && (
            <select value={resolvedSelected} onChange={(e) => setSelected(e.target.value)} style={selectStyle}>
              <option value="combined">Combined (all addresses)</option>
              {groupedAddresses.map(([label, group]) => (
                <optgroup key={label} label={label}>
                  {group.length > 1 && <option value={`cex:${label}`}>All {label} ({group.length})</option>}
                  {group.map((a) => (
                    <option key={a.address} value={a.address}>{shortHash(a.address)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>

        {chartStats ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>Current</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(chartStats.current)}</div>
              </div>
              <div>
                <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M High</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(chartStats.high)}</div>
              </div>
              <div>
                <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Low</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(chartStats.low)}</div>
              </div>
              <div>
                <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Change</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: chartStats.changePct >= 0 ? green : errorColor }}>
                  {chartStats.changePct >= 0 ? "+" : ""}{chartStats.changePct.toFixed(2)}%
                </div>
              </div>
            </div>
            <SparklineChart data={chartData} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          </>
        ) : (
          <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
            {series === null ? "Loading…" : "No balance history available yet."}
          </div>
        )}
      </div>

      <div style={sectionLabelStyle}>Addresses</div>
      <div style={{ position: "relative", padding: "0 14px 6px", background: panel2, border: `1px solid ${border}`, borderRadius: 4 }}>
        <CornerBrackets color={green} />
        {series === null ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
        ) : addresses.length === 0 ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No CEX addresses recorded yet.</div>
        ) : (
          sortedAddresses.map((a) => (
            <button
              key={a.address}
              className="dash-cex-row"
              onClick={() => onSelectAddress(a.address)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                width: "100%",
                padding: "10px 0",
                borderBottom: `1px solid ${border}`,
                background: "transparent",
                border: "none",
                borderRadius: 2,
                cursor: "pointer",
                textAlign: "left",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#fff", fontWeight: 700, fontFamily: monoFont, whiteSpace: "nowrap" }}>{a.label}</div>
                <div style={{ fontSize: 10, color: muted, fontFamily: monoFont, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {shortHash(a.address)}
                </div>
              </div>
              <div style={{ fontSize: 12, color: green, fontWeight: 700, flexShrink: 0 }}>
                <TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />{formatEtnBalance(a.balance)} ETN
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
