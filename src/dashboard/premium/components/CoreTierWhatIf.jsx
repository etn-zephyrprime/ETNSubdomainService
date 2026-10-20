import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import DashboardButton from "./DashboardButton.jsx";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { useWhatIfSimulator } from "../../hooks/useWhatIfSimulator.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { formatUsdPrice, formatEtnAmount } from "../../utils/format.js";
import { green, muted, mutedLight, orange, border, panel2, error as errorColor, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";

const inputStyle = {
  padding: "10px 12px",
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontFamily: monoFont,
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
  width: "100%",
};
const labelStyle = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4, display: "block" };
const statLabel = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4 };

const ROUTE_LABELS = {
  v3_quoter: (q) => `ElectroSwap V3 pool (${(q.feeTier / 10000).toFixed(2)}% fee)`,
  v2_router: () => "ElectroSwap V2 pool (0.3% fee)",
  spot_only: () => "Spot price — no pool could quote this size",
  native: () => "ETN itself (no swap)",
};

const qtyFmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
const signed = (n, fmt) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
const etnFmt = (n) => `${formatEtnAmount(n)} ETN`;
const pnlColor = (n) => (n >= 0 ? green : errorColor);
// Gas on Electroneum is a tiny fraction of an ETN — the 2-decimal formatters would show 0.00.
const smallEtnFmt = (n) => (n >= 0.01 ? formatEtnAmount(n) : n.toLocaleString(undefined, { maximumSignificantDigits: 3 }));
const smallUsdFmt = (n) => (n >= 0.01 ? formatUsdPrice(n) : "<$0.01");

function Stat({ label, children, tooltip }) {
  return (
    <div style={{ flex: "1 1 160px", minWidth: 0, padding: "10px 12px", borderRadius: 6, border: `1px solid ${border}`, background: panel2 }}>
      <div style={{ ...statLabel, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      {children}
    </div>
  );
}

/** Core tier "What-If" sell simulator — see backend/services/whatIfSimulator.js. Read-only: shows
 * which FIFO lots a sale would consume, what the best direct ElectroSwap pool would pay, and the
 * realized P&L in USD and ETN before and after gas. One wallet at a time (FIFO is per wallet). */
export default function CoreTierWhatIf({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getSellableHoldings, simulateSell } = useWhatIfSimulator();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));

  const [simWallet, setSimWallet] = useState(null);
  const [holdings, setHoldings] = useState(null);
  const [holdingsError, setHoldingsError] = useState(null);
  const [token, setToken] = useState("");
  const [quantity, setQuantity] = useState("");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  // Follow the page's wallet filter when it names one wallet; otherwise default to the first.
  useEffect(() => {
    if (!hasAccess || active.length === 0) return;
    const filtered = walletFilter && walletFilter !== "all" ? active.find((w) => w.address.toLowerCase() === walletFilter.toLowerCase()) : null;
    setSimWallet((current) => filtered?.address || (current && active.some((w) => w.address === current) ? current : active[0].address));
  }, [hasAccess, active, walletFilter]);

  const loadHoldings = useCallback(async (address) => {
    setHoldings(null);
    setHoldingsError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getSellableHoldings(wallet.account, signature, timestamp, address);
      setHoldings(res.holdings || []);
    } catch (err) {
      setHoldingsError(err.message || "Couldn't load this wallet's holdings");
    }
  }, [getAuthParams, getSellableHoldings, wallet.account]);

  useEffect(() => {
    if (!simWallet) return;
    setResult(null);
    setToken("");
    setQuantity("");
    loadHoldings(simWallet);
  }, [simWallet, loadHoldings]);

  const selected = useMemo(() => (holdings || []).find((h) => h.tokenAddress === token) || null, [holdings, token]);

  const run = async () => {
    setError(null);
    if (!selected) return setError("Pick a token to sell");
    const q = Number(quantity);
    if (!Number.isFinite(q) || q <= 0) return setError("Enter a quantity greater than zero");
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setResult(await simulateSell(wallet.account, signature, timestamp, { walletAddress: simWallet, tokenAddress: selected.tokenAddress, quantity: String(quantity) }));
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the simulation");
    } finally {
      setRunning(false);
    }
  };

  const setFraction = (f) => {
    if (!selected) return;
    // Exact for "max" (the ledger's own string, no float rounding); fractions are display-precision.
    setQuantity(f === 1 ? selected.quantity : String(Number(selected.quantity) * f));
  };

  return (
    <CollapsibleCoreTierPanel icon={FlaskConical} title="Core Tier — What-If Simulator" defaultCollapsed={false}>
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="simulate a sale before you make it — which lots go, what you'd get, and the P&L in USD and ETN"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Track a wallet under Core Tier — Portfolio above to simulate a sale from it.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
              See what selling would do before you do it: which of your purchases (FIFO lots) it would sell, what ElectroSwap would pay right now including price impact, and your realized profit or loss in both USD and ETN. Nothing is executed.
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <label style={labelStyle}>Wallet</label>
                <select value={simWallet || ""} onChange={(e) => setSimWallet(e.target.value)} style={inputStyle}>
                  {active.map((w) => (
                    <option key={w.address} value={w.address}>{resolveWalletName(w.address)}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <label style={labelStyle}>Token</label>
                <select value={token} onChange={(e) => { setToken(e.target.value); setQuantity(""); setResult(null); }} disabled={!holdings} style={inputStyle}>
                  <option value="">{holdings ? (holdings.length ? "Choose a token…" : "Nothing sellable in this wallet") : holdingsError ? "Couldn't load holdings" : "Loading…"}</option>
                  {(holdings || []).map((h) => (
                    <option key={h.tokenAddress} value={h.tokenAddress}>{`${h.symbol || h.tokenAddress.slice(0, 10)} — ${qtyFmt(h.quantity)} held`}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <label style={labelStyle}>Quantity to sell</label>
                <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={!selected} style={inputStyle} />
                {selected && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    {[0.25, 0.5, 1].map((f) => (
                      <button key={f} type="button" onClick={() => setFraction(f)} style={{ background: "none", border: `1px solid ${border}`, borderRadius: 4, color: mutedLight, fontSize: 10, fontFamily: monoFont, padding: "2px 8px", cursor: "pointer" }}>
                        {f === 1 ? "Max" : `${f * 100}%`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {holdingsError && <div style={{ fontSize: 12, color: errorColor }}>{holdingsError}</div>}
            {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
            <DashboardButton onClick={run} disabled={running || !selected} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
              {running ? "Simulating…" : "Simulate sale"}
            </DashboardButton>

            {result && <WhatIfResult result={result} />}
          </div>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}

function WhatIfResult({ result }) {
  const symbol = result.symbol || "tokens";
  const proceedsEtn = Number(result.proceeds.etn);
  const proceedsUsd = Number(result.proceeds.usd);
  const realizedUsd = Number(result.realized.usd);
  const realizedEtn = result.realized.etn != null ? Number(result.realized.etn) : null;
  const afterUsd = Number(result.afterGas.usd);
  const afterEtn = result.afterGas.etn != null ? Number(result.afterGas.etn) : null;
  const impact = result.quote.priceImpactPct != null ? Number(result.quote.priceImpactPct) : null;
  const route = ROUTE_LABELS[result.quote.source]?.(result.quote) || result.quote.source;
  const alt = result.quote.alternative;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>
        Selling {qtyFmt(result.quantity)} {symbol}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="You'd receive" tooltip="What the pool would pay right now for this exact amount, with its fee and the price impact of your trade already included.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{etnFmt(proceedsEtn)}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>≈ {formatUsdPrice(proceedsUsd)}</div>
        </Stat>
        <Stat label="Price impact" tooltip="How much less you'd get than the pool's current spot price for this size — includes the pool fee. Large sales move the price against you.">
          <div style={{ fontSize: 16, fontWeight: 800, color: impact == null ? mutedLight : impact >= 5 ? errorColor : impact >= 1 ? orange : "#fff" }}>{impact == null ? "—" : `${impact.toFixed(2)}%`}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>{route}</div>
        </Stat>
        <Stat label="Realized P&L (USD)" tooltip="Proceeds minus the USD cost basis of the lots sold (FIFO — oldest first, the same rule your PnL page uses).">
          <div style={{ fontSize: 16, fontWeight: 800, color: pnlColor(realizedUsd) }}>{signed(realizedUsd, formatUsdPrice)}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>after gas {signed(afterUsd, formatUsdPrice)}</div>
        </Stat>
        <Stat label="Realized P&L (ETN)" tooltip="The same sale measured in ETN: ETN received minus what those lots cost in ETN at the time you bought them. Answers 'would this leave me with more ETN than I put in?' independently of ETN's own USD price.">
          <div style={{ fontSize: 16, fontWeight: 800, color: realizedEtn == null ? mutedLight : pnlColor(realizedEtn) }}>{realizedEtn == null ? "—" : signed(realizedEtn, etnFmt)}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>{afterEtn == null ? "ETN history incomplete" : `after gas ${signed(afterEtn, etnFmt)}`}</div>
        </Stat>
      </div>

      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        Cost basis of the lots sold: <span style={{ color: "#fff" }}>{formatUsdPrice(Number(result.costBasis.usd))}</span>
        {result.costBasis.etn != null && <> · <span style={{ color: "#fff" }}>{etnFmt(Number(result.costBasis.etn))}</span></>}
        <br />
        Gas: {result.gas ? <><span style={{ color: "#fff" }}>{smallEtnFmt(Number(result.gas.etn))} ETN</span> (≈ {smallUsdFmt(Number(result.gas.usd))}){result.gas.excludesApproval ? ", plus a one-time token approval if you haven't approved it before" : ""}</> : "couldn't be estimated"}
        <br />
        Left afterwards: <span style={{ color: "#fff" }}>{qtyFmt(result.remaining.quantity)} {symbol}</span> with {formatUsdPrice(Number(result.remaining.costBasisUsd))} cost basis
        {alt && (
          <>
            <br />
            The other pool would pay {etnFmt(Number(alt.etnOut))}. ElectroSwap's app can also split a large sale across pools, so you may do slightly better there.
          </>
        )}
      </div>

      {result.warnings?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {result.warnings.map((w) => (
            <div key={w} style={{ fontSize: 11, color: orange }}>⚠ {w}</div>
          ))}
        </div>
      )}

      <div>
        <div style={statLabel}>Lots sold (FIFO — oldest first)</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 560 }}>
            <thead>
              <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Bought</th>
                <th style={{ padding: "4px 6px" }}>Quantity</th>
                <th style={{ padding: "4px 6px" }}>Cost / unit</th>
                <th style={{ padding: "4px 6px" }}>Cost basis</th>
                <th style={{ padding: "4px 6px" }}>Gain (USD)</th>
                <th style={{ padding: "4px 6px" }}>Gain (ETN)</th>
              </tr>
            </thead>
            <tbody>
              {result.lots.map((l, i) => (
                <tr key={`${l.txHash}-${i}`} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                  <td style={{ textAlign: "left", padding: "4px 6px" }}>
                    {new Date(l.acquiredAt).toLocaleDateString()} <span style={{ color: muted }}>({l.daysHeld}d)</span>
                  </td>
                  <td style={{ padding: "4px 6px" }}>{qtyFmt(l.quantity)}</td>
                  <td style={{ padding: "4px 6px" }}>{l.zeroCostBasis ? "unknown" : formatUsdPrice(Number(l.unitCostUsd))}</td>
                  <td style={{ padding: "4px 6px" }}>{formatUsdPrice(Number(l.costBasisUsd))}</td>
                  <td style={{ padding: "4px 6px", color: pnlColor(Number(l.gainUsd)) }}>{signed(Number(l.gainUsd), formatUsdPrice)}</td>
                  <td style={{ padding: "4px 6px", color: l.gainEtn == null ? muted : pnlColor(Number(l.gainEtn)) }}>{l.gainEtn == null ? "—" : signed(Number(l.gainEtn), formatEtnAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
