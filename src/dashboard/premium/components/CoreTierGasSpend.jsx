import React, { useEffect, useMemo, useState } from "react";
import { Fuel } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useGasSpend } from "../../hooks/useGasSpend.js";
import { formatChartDate } from "../../utils/format.js";
import { muted, mutedLight, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const labelStyle = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 };

function fmtGas(n) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0 ETN";
  if (Math.abs(n) >= 1_000_000) return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)} ETN`;
  // Gas is small per tx; keep enough precision that a tiny wallet doesn't read as "0.00".
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 })} ETN`;
}

// Core Tier: cumulative gas spent, in ETN, across the member's tracked wallets (or the one picked
// in the page-wide wallet filter). Built from the ingested transfer history's gas rows — one per
// transaction the wallet itself sent, failed ones included — so it only covers what's been ingested.
export default function CoreTierGasSpend({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getGasSpend } = useGasSpend();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setData(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getGasSpend(wallet.account, signature, timestamp);
        if (!cancelled) setData(res.perWallet || []);
      } catch (err) {
        console.error("Failed to load gas spend:", err.message);
        if (!cancelled) setError("Couldn't load gas spend. Try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [hasAccess, active, getAuthParams, getGasSpend, wallet.account]);

  const { series, total, txCount } = useMemo(() => {
    const selected = (data || []).filter((w) => walletFilter === "all" || w.walletAddress === walletFilter);
    const perDay = new Map();
    let count = 0;
    for (const w of selected) {
      for (const d of w.daily) {
        perDay.set(d.day, (perDay.get(d.day) || 0) + d.etn);
        count += d.txCount;
      }
    }
    const days = [...perDay.keys()].sort();
    let running = 0;
    const points = days.map((day) => {
      running += perDay.get(day);
      return { label: `${day}T00:00:00Z`, value: running };
    });
    // A single day of activity can't draw a line — anchor it with a zero point the day before.
    if (points.length === 1) {
      const prev = new Date(days[0] + "T00:00:00Z");
      prev.setUTCDate(prev.getUTCDate() - 1);
      points.unshift({ label: prev.toISOString(), value: 0 });
    }
    return { series: points, total: running, txCount: count };
  }, [data, walletFilter]);

  return (
    <CollapsibleCoreTierPanel icon={Fuel} title="Core Tier — Gas Spent">
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see how much ETN your tracked wallets have spent on gas"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>No wallets tracked yet — add one under Core Tier — Portfolio above.</div>
        ) : error ? (
          <div style={{ fontSize: 12, color: "#ff6b6b" }}>{error}</div>
        ) : data == null ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Loading gas spend…</div>
        ) : (
          <div>
            <div style={labelStyle}>Cumulative gas spent</div>
            <div style={{ fontFamily: monoFont, fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 2 }}>{fmtGas(total)}</div>
            <div style={{ fontSize: 10, color: muted, marginBottom: 12 }}>
              {txCount.toLocaleString()} transaction{txCount === 1 ? "" : "s"} sent · all time, failed transactions included
            </div>
            {series.length < 2 ? (
              <div style={{ fontSize: 12, color: muted }}>No gas spend recorded yet.</div>
            ) : (
              <SparklineChart data={series} height={140} formatValue={fmtGas} formatLabel={formatChartDate} />
            )}
          </div>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
