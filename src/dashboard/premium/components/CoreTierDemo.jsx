import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { LineChart, TrendingUp } from "lucide-react";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useBlockscout } from "../../hooks/useBlockscout.js";
import { useEtnPriceHistory } from "../../hooks/useEtnPriceHistory.js";
import { useCoreTierDemo } from "../../hooks/useCoreTierDemo.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { buildEtnPriceLookup, convertSeriesToUsd, buildDailySeries } from "../../utils/balanceHistory.js";
import { getHistoricalBalance } from "../../utils/historicalBalance.js";
import { formatChartDate, formatUsdPrice } from "../../utils/format.js";
import { green, muted, mutedLight, border, panel2, error as errorColor } from "../../theme.js";

// planetzephyros.etn — resolved live via Blockscout's ENS reverse-index (api/v2/search) before
// hardcoding here; this is DEMO_WALLET_ADDRESSES[0] in coreTierDemoRouter.js, which now combines
// two more real wallets alongside it for the PnL preview below (DemoPnl) — this constant is used
// ONLY for Balance History, which stays single-wallet (that section's own data sources are all
// public/client-side calls, with no natural "combine several wallets' balance history" endpoint to
// reach for the way DemoPnl has coreTierDemoRouter.js's own combineLivePnlSnapshots). Must stay in
// sync with coreTierDemoRouter.js's own copy of this same address — no shared build step between
// frontend/backend in this repo (same reasoning as several other hand-synced constants elsewhere).
const DEMO_WALLET_ADDRESS = "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099";
const WINDOW_DAYS = 365; // matches CoreTierBalanceHistory.jsx's own rolling-12-months convention

function fmtEtn(v) {
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;
}
function pnlColor(v) {
  return v > 0 ? green : v < 0 ? errorColor : mutedLight;
}
function fmtSigned(v) {
  return `${v >= 0 ? "+" : ""}${formatUsdPrice(v)}`;
}
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };

/** A single wallet's own ETN Balance History chart, for DEMO_WALLET_ADDRESS only — same data
 * sources and math CoreTierBalanceHistory.jsx uses for one wallet (Blockscout's coin-balance-
 * history-by-day + historicalBalance.js's older-than-90-days backfill + this app's own
 * /api/etn-price-history for the USD toggle), all already public/unauthenticated, so this needs no
 * backend involvement of its own beyond what those hooks already call directly. */
function DemoBalanceHistory() {
  const { getAddressCoinBalanceHistory } = useBlockscout();
  const { getEtnPriceHistory } = useEtnPriceHistory();

  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [seedEtn, setSeedEtn] = useState(0);
  const [pricePoints, setPricePoints] = useState(null);
  const [valueMode, setValueMode] = useState("etn");

  useEffect(() => {
    let cancelled = false;
    getAddressCoinBalanceHistory(DEMO_WALLET_ADDRESS)
      .then((res) => { if (!cancelled) setItems(Array.isArray(res?.items) ? res.items : []); })
      .catch((err) => {
        console.error("Demo: failed to load balance history:", err.message);
        if (!cancelled) setError("Couldn't load demo balance history.");
      });
    return () => { cancelled = true; };
  }, [getAddressCoinBalanceHistory]);

  useEffect(() => {
    let cancelled = false;
    getHistoricalBalance(DEMO_WALLET_ADDRESS, WINDOW_DAYS).then((v) => { if (!cancelled) setSeedEtn(v ?? 0); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getEtnPriceHistory("all")
      .then((res) => { if (!cancelled) setPricePoints(Array.isArray(res?.points) ? res.points : []); })
      .catch(() => { if (!cancelled) setPricePoints([]); });
    return () => { cancelled = true; };
  }, [getEtnPriceHistory]);

  const priceLookup = useMemo(() => (pricePoints && pricePoints.length > 0 ? buildEtnPriceLookup(pricePoints) : null), [pricePoints]);
  const usdReady = priceLookup != null;
  const showUsd = valueMode === "usd" && usdReady;

  const sparse = useMemo(
    () => (items || []).map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) })),
    [items]
  );
  const seriesEtn = useMemo(() => buildDailySeries(sparse, WINDOW_DAYS, seedEtn), [sparse, seedEtn]);
  const series = showUsd ? convertSeriesToUsd(seriesEtn, priceLookup) : seriesEtn;
  const formatValue = showUsd ? formatUsdPrice : fmtEtn;
  const hasHistory = sparse.length > 0 || seedEtn > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <LineChart size={16} color={green} />
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>Balance History</div>
        </div>
        {items && (
          <div style={{ display: "flex", gap: 6 }}>
            {[{ id: "etn", label: "ETN" }, { id: "usd", label: "USD" }].map((m) => (
              <button
                key={m.id}
                onClick={() => setValueMode(m.id)}
                disabled={m.id === "usd" && !usdReady}
                style={{
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: `1px solid ${m.id === valueMode ? green : border}`,
                  background: m.id === valueMode ? "rgba(24,187,26,0.12)" : panel2,
                  color: m.id === "usd" && !usdReady ? muted : m.id === valueMode ? green : mutedLight,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: m.id === "usd" && !usdReady ? "not-allowed" : "pointer",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
      {error ? (
        <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
      ) : !items ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Loading…</div>
      ) : !hasHistory ? (
        <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
      ) : (
        <SparklineChart data={series} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
      )}
    </div>
  );
}

/** Live PnL preview combining THREE real demo wallets (see coreTierDemoRouter.js's own
 * DEMO_WALLET_ADDRESSES) — Current Value/Unrealized/Realized, a per-wallet breakdown, Current
 * Holdings, and the Value Over Time chart, same shape CoreTierPnl.jsx renders for a real member's
 * own multiple tracked wallets combined, sourced from coreTierDemoRouter.js's cached public
 * endpoint instead of a signed, per-member request. No Refresh button (that endpoint is cached for
 * up to an hour server-side — a client-side refresh within that window wouldn't do anything
 * different) and no cold-start token picker (each demo wallet's own ingestion, if ever needed,
 * already ran once to seed the cache; a visitor never triggers it themselves).
 *
 * The per-wallet breakdown is labeled "Wallet 1/2/3" — never a real address or ENS name, same
 * anonymity requirement the original single-wallet demo was already built to (see
 * coreTierDemoRouter.js's own comment); coreTierDemoRouter.js never sends a real address down for
 * this, only a walletIndex.
 */
function DemoPnl({ onSelectToken }) {
  const { getDemoPnl } = useCoreTierDemo();
  const [data, setData] = useState(null); // { snapshot, perWallet, history } | null while loading
  const [error, setError] = useState(null);
  const { resolve: resolveTokenName, isSpam: isSpamToken } = useTokenNames((data?.snapshot?.holdings || []).map((h) => h.tokenAddress));

  useEffect(() => {
    let cancelled = false;
    getDemoPnl()
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        console.error("Demo: failed to load PnL:", err.message);
        if (!cancelled) setError("Couldn't load demo PnL right now.");
      });
    return () => { cancelled = true; };
  }, [getDemoPnl]);

  const snapshot = data?.snapshot;
  const perWallet = data?.perWallet || [];
  const history = data?.history || [];
  const holdings = (snapshot?.holdings || []).filter((h) => !isSpamToken(h.tokenAddress) && h.marketValueUsd != null);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <TrendingUp size={16} color={green} />
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>PnL</div>
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
      ) : !snapshot ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Loading…</div>
      ) : (
        <>
          {perWallet.length > 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${border}` }}>
              <div style={{ fontSize: 10, color: muted, marginBottom: 2 }}>{perWallet.length} wallets combined</div>
              {perWallet.map((w) => (
                <div key={w.walletIndex} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: mutedLight }}>Wallet {w.walletIndex + 1}</span>
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={sectionHeaderStyle}>Current Value</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(snapshot.currentValueUsd))}</div>
            </div>
            <div>
              <div style={sectionHeaderStyle}>Unrealized P&amp;L</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: pnlColor(Number(snapshot.unrealizedPnlUsd)) }}>
                {fmtSigned(Number(snapshot.unrealizedPnlUsd))}
              </div>
            </div>
            <div>
              <div style={sectionHeaderStyle}>Realized P&amp;L</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: pnlColor(Number(snapshot.realizedPnlUsd)) }}>
                {fmtSigned(Number(snapshot.realizedPnlUsd))}
              </div>
            </div>
          </div>

          {holdings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionHeaderStyle}>Current Holdings</div>
              {holdings
                .slice()
                .sort((a, b) => Number(b.marketValueUsd) - Number(a.marketValueUsd))
                .slice(0, 8)
                .map((h) => {
                  const unrealized = Number(h.marketValueUsd) - Number(h.costBasisUsd);
                  return (
                    <div key={h.tokenAddress} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${border}` }}>
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
                        <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{formatUsdPrice(Number(h.marketValueUsd))}</span>
                        <span style={{ display: "block", fontSize: 10, color: pnlColor(unrealized) }}>{fmtSigned(unrealized)}</span>
                      </span>
                    </div>
                  );
                })}
            </div>
          )}

          <div>
            <div style={sectionHeaderStyle}>Value Over Time</div>
            {history.length === 0 ? (
              <div style={{ fontSize: 12, color: mutedLight }}>No history yet.</div>
            ) : (
              <SparklineChart
                data={history.map((p) => ({ label: p.date, value: p.totalValueUsd }))}
                height={120}
                formatValue={(v) => formatUsdPrice(v)}
                formatLabel={formatChartDate}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Core Tier's actual value proposition, previewed for three fixed real wallets — Balance History
 * (wallet 1 only, see DEMO_WALLET_ADDRESS's own comment) and PnL (all three combined, matching the
 * real multi-wallet tracking feature) — available to anyone, including a visitor with no wallet
 * connected at all. See CoreTierPortfolio.jsx's own "View Demo" toggle, which renders this in place
 * of CoreTierGate's connect/subscribe messaging. */
export default function CoreTierDemo({ onSelectToken }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <DemoBalanceHistory />
      <div style={{ borderTop: `1px solid ${border}`, paddingTop: 20 }}>
        <DemoPnl onSelectToken={onSelectToken} />
      </div>
    </div>
  );
}
