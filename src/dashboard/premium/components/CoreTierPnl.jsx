import React, { useCallback, useEffect, useState } from "react";
import { TrendingUp, RefreshCw, Info } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useCoreTierAccess } from "../../hooks/useCoreTierAccess.js";
import { usePnlSnapshot } from "../../hooks/usePnlSnapshot.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { formatUsdPrice, formatChartDate } from "../../utils/format.js";
import { green, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };

function pnlColor(v) {
  return v > 0 ? green : v < 0 ? errorColor : mutedLight;
}
function fmtSigned(v) {
  return `${v >= 0 ? "+" : ""}${formatUsdPrice(v)}`;
}

// Core tier's ongoing dashboard PnL — a live, lightweight "how am I doing right now" view, built
// on the EXACT SAME FIFO ledger the PnL Statement product uses (pnlSnapshotService.js reuses
// pnlEventBuilder.js/fifoLotEngine.js verbatim, not a second implementation) so this can never
// disagree with a Statement for the same wallet/token/timestamp.
//
// Deliberately narrower than the Statement — see the build brief's own "must not compete with"
// framing: no CEX inclusion, no fixed reporting periods, no immutable/exportable artifact, no
// per-disposal ledger. This is a running total and current snapshot only, always recomputed live
// (never frozen), with an explicit upsell to the Statement for anything more formal.
//
// The live figures are a real computation (same order of magnitude as generating a Statement, not
// a quick read) — fetched once on load, then only again if the member explicitly asks via
// Refresh, not on a timer. The chart below reads a cheap pre-computed daily rollup instead
// (pnlSnapshotScheduler.js), so it loads fast even though the "right now" numbers above it don't.
export default function CoreTierPnl({ wallet, membershipVersion = 0, getAuthParams, onSelectToken }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } =
    useCoreTierAccess(wallet, membershipVersion, getAuthParams);
  const { getLiveSnapshot, getHistory } = usePnlSnapshot();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));

  const [snapshot, setSnapshot] = useState(null); // { perWallet, combined } | null
  const [snapshotError, setSnapshotError] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [history, setHistory] = useState(null); // { combined: [{date,...}] } | null
  const [historyError, setHistoryError] = useState(null);

  const { resolve: resolveTokenName, isSpam: isSpamToken } = useTokenNames((snapshot?.combined?.holdings || []).map((h) => h.tokenAddress));
  const [showHiddenTokens, setShowHiddenTokens] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getLiveSnapshot(wallet.account, signature, timestamp);
      setSnapshot(res);
    } catch (err) {
      setSnapshotError(err.message || "Couldn't compute your live PnL");
    } finally {
      setSnapshotLoading(false);
    }
  }, [getAuthParams, getLiveSnapshot, wallet.account]);

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getHistory(wallet.account, signature, timestamp);
      setHistory(res);
    } catch (err) {
      setHistoryError(err.message || "Couldn't load PnL history");
    }
  }, [getAuthParams, getHistory, wallet.account]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setSnapshot(null);
      setHistory(null);
      return;
    }
    loadSnapshot();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  const combined = snapshot?.combined;
  const combinedHistory = history?.combined || [];
  const formatValue = (v) => formatUsdPrice(v);

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <TrendingUp size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Core Tier — PnL
          </div>
        </div>
        {hasAccess && active.length > 0 && (
          <DashboardButton
            onClick={loadSnapshot}
            disabled={snapshotLoading}
            style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={12} />
            {snapshotLoading ? "Refreshing…" : "Refresh"}
          </DashboardButton>
        )}
      </div>

      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see live holdings and running P&L for your tracked wallets"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            Track a wallet under Core Tier — Portfolio above to see its PnL here.
          </div>
        ) : (
          <>
            {/* Required disclaimer + upsell — this view is never a record, the Statement is */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
              <Info size={14} color={mutedLight} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
                This is a live estimate for your own reference and updates continuously — it's not a formal record.
                For an immutable, downloadable statement suitable for tax purposes,{" "}
                <a href="/pnl" style={{ color: green, textDecoration: "underline" }}>generate a PnL Statement</a>.
              </div>
            </div>

            {snapshotError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{snapshotError}</div>}
            {snapshot?.failed?.length > 0 && snapshot?.combined && (
              <div style={{ fontSize: 11, color: errorColor, marginBottom: 12 }}>
                Couldn't compute PnL for {snapshot.failed.map((a) => resolveWalletName(a)).join(", ")} right now — the figures below only
                reflect your other tracked wallet{snapshot.failed.length === active.length - 1 ? "" : "s"}. Try Refresh.
              </div>
            )}

            {!snapshot && !snapshotError ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>Computing your live PnL — this can take a moment…</div>
            ) : !combined && snapshot ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
                Couldn't compute PnL for any of your tracked wallets right now — try Refresh.
              </div>
            ) : combined ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
                  <div>
                    <div style={sectionHeaderStyle}>Current Value</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(combined.currentValueUsd))}</div>
                  </div>
                  <div>
                    <div style={sectionHeaderStyle}>Unrealized P&amp;L</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor(Number(combined.unrealizedPnlUsd)) }}>
                      {fmtSigned(Number(combined.unrealizedPnlUsd))}
                    </div>
                  </div>
                  <div>
                    <div style={sectionHeaderStyle}>Realized P&amp;L (running total)</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor(Number(combined.realizedPnlUsd)) }}>
                      {fmtSigned(Number(combined.realizedPnlUsd))}
                    </div>
                    <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>Since tracking began, net of gas</div>
                  </div>
                </div>

                {active.length > 1 && snapshot.perWallet && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
                    {snapshot.perWallet.map((w) => (
                      <div key={w.walletAddress} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: mutedLight }}>
                          {w.walletAddress.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                          {resolveWalletName(w.walletAddress)}
                        </span>
                        <span style={{ display: "flex", gap: 10 }}>
                          <span style={{ color: "#fff", fontWeight: 700 }}>{formatUsdPrice(Number(w.currentValueUsd))}</span>
                          <span style={{ color: pnlColor(Number(w.unrealizedPnlUsd) + Number(w.realizedPnlUsd)) }}>
                            {fmtSigned(Number(w.unrealizedPnlUsd) + Number(w.realizedPnlUsd))}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginBottom: 20 }}>
                  <div style={sectionHeaderStyle}>Current Holdings</div>
                  {(() => {
                    // isSpam(address) checks the token's actual resolved name (never a hex
                    // fallback — see useTokenNames.js's own comment on why). marketValueUsd null
                    // means dexPriceQuote.js found no ElectroSwap pool at all for this token
                    // (checked server-side against GeckoTerminal's full pool list, not a narrow
                    // recent-activity window) — a confirmed negative, safe to hide by default.
                    const allHoldings = combined.holdings.filter((h) => !isSpamToken(h.tokenAddress));
                    const hiddenCount = allHoldings.filter((h) => h.marketValueUsd == null).length;
                    const shown = (showHiddenTokens ? allHoldings : allHoldings.filter((h) => h.marketValueUsd != null))
                      .slice()
                      .sort((a, b) => (Number(b.marketValueUsd) || 0) - (Number(a.marketValueUsd) || 0));

                    if (allHoldings.length === 0) {
                      return <div style={{ fontSize: 12, color: muted }}>No holdings across your tracked wallets right now.</div>;
                    }
                    return (
                      <>
                        {shown.map((h) => {
                          const unrealized = h.marketValueUsd != null ? Number(h.marketValueUsd) - Number(h.costBasisUsd) : null;
                          return (
                            <div key={h.tokenAddress} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}>
                              <span style={{ fontSize: 12, color: "#fff" }}>
                                {onSelectToken ? (
                                  <button
                                    type="button"
                                    onClick={() => onSelectToken(h.tokenAddress)}
                                    style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                                    onMouseEnter={(e) => { e.currentTarget.style.textDecorationColor = green; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.textDecorationColor = "transparent"; }}
                                    title="View on the Tokens page"
                                  >
                                    {resolveTokenName(h.tokenAddress)}
                                  </button>
                                ) : (
                                  resolveTokenName(h.tokenAddress)
                                )}
                              </span>
                              <span style={{ textAlign: "right" }}>
                                <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>
                                  {h.marketValueUsd != null ? formatUsdPrice(Number(h.marketValueUsd)) : "price unavailable"}
                                </span>
                                {unrealized != null && (
                                  <span style={{ display: "block", fontSize: 10, color: pnlColor(unrealized) }}>{fmtSigned(unrealized)}</span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {!showHiddenTokens && hiddenCount > 0 && (
                          <div style={{ marginTop: 10, fontSize: 11, color: muted, textAlign: "center" }}>
                            {hiddenCount} token{hiddenCount === 1 ? "" : "s"} hidden (no ElectroSwap pool found) —{" "}
                            <button type="button" onClick={() => setShowHiddenTokens(true)} style={{ background: "none", border: "none", padding: 0, color: green, cursor: "pointer", textDecoration: "underline", fontSize: 11 }}>
                              Show
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            ) : null}

            <div>
              <div style={sectionHeaderStyle}>Value Over Time</div>
              {historyError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{historyError}</div>
              ) : combinedHistory.length === 0 ? (
                <div style={{ fontSize: 12, color: mutedLight }}>
                  No history yet — this fills in once the daily snapshot has run at least once.
                </div>
              ) : (
                <SparklineChart
                  data={combinedHistory.map((p) => ({ label: p.date, value: p.totalValueUsd }))}
                  height={120}
                  formatValue={formatValue}
                  formatLabel={formatChartDate}
                />
              )}
            </div>
          </>
        )}
      </CoreTierGate>
    </DashboardPanel>
  );
}
