import React, { useEffect, useState } from "react";
import { useReownWallet } from "../../hooks/useReownWallet.jsx";
import { usePnlStats } from "../hooks/usePnlStats.js";
import PremiumWalletChip from "./components/PremiumWalletChip.jsx";
import PnlStatementRequest from "./components/PnlStatementRequest.jsx";
import PnlStatementViewer from "./components/PnlStatementViewer.jsx";
import DashboardPanel from "./components/DashboardPanel.jsx";
import StatCard from "../components/StatCard.jsx";
import SparklineChart from "../components/SparklineChart.jsx";
import { green, greenGlow, muted, mutedLight } from "../theme.js";

function fmtCore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 2 })} CORE`;
}

function fmtDateLabel(label, full = false) {
  const d = new Date(label);
  if (Number.isNaN(d.getTime())) return String(label);
  return full
    ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Premium Feature #1 — per-wallet PnL statements. One of two wallet-requiring tabs on this
// otherwise-walletless dashboard, the other being PortfolioDashboardSection.jsx (Core Tier — kept
// as its own separate tab/lazy chunk rather than stacked in here: a one-off "buy a report"
// transaction and an ongoing "check my balances" utility are different enough mental models that
// bundling them under one heading/scroll got confusing, and this is explicitly the first of more
// premium features to come — separate tabs scales better than one ever-growing "Premium" tab).
// DashboardApp.jsx loads this module lazily (React.lazy, only once the PnL Statement tab is
// actually clicked), which is what keeps the WalletConnect/AppKit side effect this import
// triggers (see useReownWallet.jsx's own top-level createAppKit() call) out of the base dashboard
// bundle for every visitor who never touches either wallet-requiring tab.
export default function PremiumDashboardSection({ initialStatementRequestId = null }) {
  const wallet = useReownWallet();
  const [showViewer, setShowViewer] = useState(!!initialStatementRequestId);

  // Site-wide stats (CORE burned via this contract's own buy-and-burn flow, cumulative statements
  // requested) — same for every visitor, doesn't depend on a connected wallet, so this fetches
  // regardless of wallet.isConnected/showViewer state.
  const { getStats } = usePnlStats();
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getStats();
        if (!cancelled) setStats(data);
      } catch (err) {
        console.error("Failed to load PnL stats:", err);
        if (!cancelled) setStatsError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [getStats]);

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          PnL Statements
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      {!showViewer && (
        <div style={{ marginBottom: 20 }}>
          <PremiumWalletChip wallet={wallet} />
        </div>
      )}

      {showViewer ? (
        <PnlStatementViewer
          initialRequestId={initialStatementRequestId}
          onBack={() => setShowViewer(false)}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <PnlStatementRequest wallet={wallet} />

          <button
            onClick={() => setShowViewer(true)}
            style={{ background: "none", border: "none", color: green, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "center", padding: "8px 0" }}
          >
            Already have a statement? Look it up by request ID or transaction hash →
          </button>

          {statsError ? (
            <div style={{ fontSize: 11, color: mutedLight, textAlign: "center" }}>Stats unavailable right now.</div>
          ) : (
            <>
              <StatCard
                label="CORE Burned"
                value={stats ? fmtCore(stats.totalCoreBurned) : "…"}
                sub="Via this contract's own buy-and-burn — not other burn sources on Electroneum."
              />

              <DashboardPanel>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                  Statements Requested (Cumulative)
                </div>
                {!stats ? (
                  <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
                    Loading…
                  </div>
                ) : (
                  <SparklineChart
                    data={stats.cumulativeRequested}
                    height={140}
                    formatValue={(v) => String(Math.round(v))}
                    formatLabel={fmtDateLabel}
                  />
                )}
              </DashboardPanel>
            </>
          )}
        </div>
      )}
    </div>
  );
}
