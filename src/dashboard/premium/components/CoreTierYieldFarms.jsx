import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Sprout, RefreshCw } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import DashboardButton from "./DashboardButton.jsx";
import LpCompositionChart from "./LpCompositionChart.jsx";
import { useYieldFarms } from "../../hooks/useYieldFarms.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { EXPLORER_BASE_URL } from "../../../config.js";
import { green, gold, blue, orange, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const ROWS_COLLAPSED = 10;
const sectionHeaderStyle = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };

function fmtAmount(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
  if (abs >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

// Core Tier — Yield Farms. Top (the part that matters most to a member): their own liquidity and farm
// positions' token0 vs token1 balances and ETN value over time (LpCompositionChart). Below: a live
// snapshot of every ElectroSwap yield farm — which wallets are in it and how much of each token each
// still has in it (backend/services/yieldFarmSnapshot.js, read from the YieldFarm contract's
// getFarmerByFarmIdAndAddress; cached 10 minutes), with the member's own wallets highlighted.
export default function CoreTierYieldFarms({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getYieldFarms } = useYieldFarms();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [farmId, setFarmId] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setSnapshot(await getYieldFarms(wallet.account, signature, timestamp));
    } catch (err) {
      setError(err.message || "Couldn't load the yield farms");
    } finally {
      setLoading(false);
    }
  }, [getAuthParams, getYieldFarms, wallet.account]);

  useEffect(() => {
    if (!hasAccess) return;
    load();
    // Keyed on access only — not load/getAuthParams (rebuilt every render; see CoreTierGasSpend.jsx's load effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess]);

  const farms = snapshot?.farms || [];
  const farm = farms.find((f) => f.id === farmId) || farms.find((f) => f.active) || farms[0] || null;
  const mine = useMemo(() => new Set(active.map((w) => w.address.toLowerCase())), [active]);
  const { resolve } = useDisplayNames(farm ? farm.farmers.map((f) => f.address) : []);
  const { resolve: resolveMine } = useDisplayNames(active.map((w) => w.address));

  const rows = farm ? (showAll ? farm.farmers : farm.farmers.slice(0, ROWS_COLLAPSED)) : [];
  const myRows = farm ? farm.farmers.filter((f) => mine.has(f.address.toLowerCase())) : [];

  return (
    <CollapsibleCoreTierPanel
      icon={Sprout}
      title="Core Tier — Yield Farms"
      defaultCollapsed={false}
      headerRight={
        hasAccess && (
          <DashboardButton
            onClick={load}
            disabled={loading}
            style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={12} />
            {loading ? "Refreshing…" : "Refresh"}
          </DashboardButton>
        )
      }
    >
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see who's in each ElectroSwap yield farm and how much they hold"
      >
        <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
          <div style={sectionHeaderStyle}>Your positions — token balances over time</div>
          {active.length === 0 ? (
            <div style={{ fontSize: 12, color: mutedLight }}>Track a wallet under Core Tier — Portfolio to see its positions here.</div>
          ) : (
            <LpCompositionChart
              wallet={wallet}
              getAuthParams={getAuthParams}
              walletFilter={walletFilter}
              resolveWalletName={resolveMine}
              multiWallet={active.length > 1}
            />
          )}
        </div>
        <div style={sectionHeaderStyle}>Farm snapshot</div>
        {error ? (
          <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
        ) : !snapshot ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Reading every farm and farmer from the YieldFarm contract…</div>
        ) : !farm ? (
          <div style={{ fontSize: 12, color: mutedLight }}>No farms have anything in them right now.</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {farms.map((f) => {
                const on = f.id === farm.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      setFarmId(f.id);
                      setShowAll(false);
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: `1px solid ${on ? gold : border}`,
                      background: on ? "rgba(232,191,76,0.14)" : panel2,
                      color: on ? gold : mutedLight,
                      fontFamily: monoFont,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                      opacity: f.active ? 1 : 0.7,
                    }}
                  >
                    {f.name}
                    {f.active ? "" : " · ended"} · {f.farmers.length}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 14 }}>
              {[
                { label: `${farm.token0.symbol} in farm`, value: fmtAmount(farm.total.amount0), color: blue },
                { label: `${farm.token1.symbol} in farm`, value: fmtAmount(farm.total.amount1), color: orange },
                { label: "Wallets", value: farm.farmers.length, color: "#fff" },
                { label: "Status", value: farm.active ? "Active" : "Ended", color: farm.active ? green : mutedLight },
              ].map((c) => (
                <div key={c.label} style={{ padding: "10px 12px", borderRadius: 6, border: `1px solid ${border}`, background: panel2 }}>
                  <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4 }}>{c.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            {myRows.length > 0 && (
              <div style={{ fontSize: 12, color: gold, marginBottom: 10 }}>
                You're in this farm:{" "}
                {myRows.map((r) => `${resolveMine(r.address)} ${r.sharePct.toFixed(2)}%`).join(", ")}
              </div>
            )}

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: muted, fontFamily: monoFont, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6 }}>
                    <th style={{ textAlign: "left", padding: "6px 4px", borderBottom: `1px solid ${border}` }}>#</th>
                    <th style={{ textAlign: "left", padding: "6px 4px", borderBottom: `1px solid ${border}` }}>Wallet</th>
                    <th style={{ textAlign: "right", padding: "6px 4px", borderBottom: `1px solid ${border}`, color: blue }}>{farm.token0.symbol}</th>
                    <th style={{ textAlign: "right", padding: "6px 4px", borderBottom: `1px solid ${border}`, color: orange }}>{farm.token1.symbol}</th>
                    <th style={{ textAlign: "right", padding: "6px 4px", borderBottom: `1px solid ${border}` }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isMine = mine.has(r.address.toLowerCase());
                    return (
                      <tr key={r.address} style={{ background: isMine ? "rgba(232,191,76,0.08)" : "transparent" }}>
                        <td style={{ padding: "6px 4px", color: muted }}>{i + 1}</td>
                        <td style={{ padding: "6px 4px" }}>
                          <a href={`${EXPLORER_BASE_URL}/address/${r.address}`} target="_blank" rel="noopener noreferrer" style={{ color: isMine ? gold : "#fff", textDecoration: "none", fontFamily: monoFont }}>
                            {resolve(r.address)}
                          </a>
                          {isMine && <span style={{ marginLeft: 6, fontSize: 10, color: gold }}>you</span>}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontFamily: monoFont }}>{fmtAmount(r.amount0)}</td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontFamily: monoFont }}>{fmtAmount(r.amount1)}</td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontFamily: monoFont, color: mutedLight }}>{r.sharePct < 0.01 ? "<0.01" : r.sharePct.toFixed(2)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {farm.farmers.length > ROWS_COLLAPSED && (
              <button onClick={() => setShowAll((v) => !v)} style={{ background: "none", border: "none", color: green, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "8px 0" }}>
                {showAll ? "Show top 10" : `Show all ${farm.farmers.length} wallets`}
              </button>
            )}
            <div style={{ fontSize: 10, color: muted, marginTop: 6, lineHeight: 1.4 }}>
              Each wallet's share of the farm's liquidity, as token amounts at the pool's current price — principal only (pending rewards and fees not included). Updated {ago(snapshot.asOf)}.
            </div>
          </>
        )}

      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
