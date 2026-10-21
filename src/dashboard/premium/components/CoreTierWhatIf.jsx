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
import { ResultCard, Hero, Kpi, KpiRow, Eyebrow, Callout, WarningList, AssumptionsStrip, Intro, usdShort, toneFor, pctText, etnShort } from "./ScenarioBits.jsx";

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
const chipStyle = { background: "none", border: `1px solid ${border}`, borderRadius: 4, color: mutedLight, fontSize: 10, fontFamily: monoFont, padding: "2px 8px", cursor: "pointer" };

const ROUTE_LABELS = {
  v3_quoter: (q) => `ElectroSwap V3 pool (${(q.feeTier / 10000).toFixed(2)}% fee)`,
  v2_router: () => "ElectroSwap V2 pool (0.3% fee)",
  spot_only: () => "Spot price — no pool could quote this size",
  native: () => "ETN itself (no swap)",
};
const KIND_LABELS = { farm: "Yield farm", staking: "Staking", v2: "Liquidity pool", v3: "V3 position" };

const qtyFmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
const shortQty = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: Number(v) >= 100 ? 0 : 4 });
const signed = (n, fmt) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
const etnFmt = (n) => `${formatEtnAmount(n)} ETN`;
// Gas on Electroneum is a tiny fraction of an ETN — the 2-decimal formatters would show 0.00.
const smallUsdFmt = (n) => (n >= 0.01 ? formatUsdPrice(n) : "<$0.01");
const dateFmt = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });




/** Core tier "What-If" simulator — see backend/services/whatIfSimulator.js. Read-only. Two modes:
 * sell a freely-held token (which FIFO lots go, the best ElectroSwap quote, P&L in USD and ETN), or
 * exit an LP / farm / staking position (what comes back, optionally all sold to ETN, P&L against what
 * the position cost). One wallet at a time — FIFO is per wallet. */
export default function CoreTierWhatIf({ wallet, getAuthParams, coreTierAccess, walletFilter, embedded = false }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getSellableHoldings, simulateSell, simulateExit } = useWhatIfSimulator();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));

  const [simWallet, setSimWallet] = useState(null);
  const [mode, setMode] = useState("token"); // "token" | "position"
  const [holdings, setHoldings] = useState(null); // { tokens, positions }
  const [holdingsError, setHoldingsError] = useState(null);
  const [token, setToken] = useState("");
  const [quantity, setQuantity] = useState("");
  const [positionKey, setPositionKey] = useState("");
  const [exitPct, setExitPct] = useState("100");
  const [sellToEtn, setSellToEtn] = useState(true);
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
      setHoldings({ tokens: res.tokens || [], positions: res.positions || [] });
    } catch (err) {
      setHoldingsError(err.message || "Couldn't load this wallet's holdings");
    }
  }, [getAuthParams, getSellableHoldings, wallet.account]);

  // Keyed on the chosen wallet only — NOT loadHoldings, whose identity follows getAuthParams, which
  // is rebuilt on every parent render (see CoreTierGasSpend.jsx's load effect): depending on it
  // reloaded holdings (a heavy request) and wiped the form on every render.
  useEffect(() => {
    if (!simWallet) return;
    setResult(null);
    setToken("");
    setQuantity("");
    setPositionKey("");
    loadHoldings(simWallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simWallet]);

  const selectedToken = useMemo(() => (holdings?.tokens || []).find((h) => h.tokenAddress === token) || null, [holdings, token]);
  const selectedPosition = useMemo(() => (holdings?.positions || []).find((p) => p.key === positionKey) || null, [holdings, positionKey]);

  const switchMode = (m) => {
    setMode(m);
    setResult(null);
    setError(null);
  };

  const run = async () => {
    setError(null);
    if (mode === "token") {
      if (!selectedToken) return setError("Pick a token to sell");
      const q = Number(quantity);
      if (!Number.isFinite(q) || q <= 0) return setError("Enter a quantity greater than zero");
    } else {
      if (!selectedPosition) return setError("Pick a position to exit");
      const p = Number(exitPct);
      if (!Number.isFinite(p) || p <= 0 || p > 100) return setError("Enter an exit percentage between 0 and 100");
    }
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const r =
        mode === "token"
          ? await simulateSell(wallet.account, signature, timestamp, { walletAddress: simWallet, tokenAddress: selectedToken.tokenAddress, quantity: String(quantity) })
          : await simulateExit(wallet.account, signature, timestamp, { walletAddress: simWallet, positionKey, exitPct: Number(exitPct), sellToEtn });
      setResult({ mode, data: r });
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the simulation");
    } finally {
      setRunning(false);
    }
  };

  const setFraction = (f) => {
    if (!selectedToken) return;
    // Exact for "max" (the ledger's own string, no float rounding); fractions are display-precision.
    setQuantity(f === 1 ? selectedToken.quantity : String(Number(selectedToken.quantity) * f));
  };

  const tabStyle = (m) => ({
    ...chipStyle,
    fontSize: 11,
    padding: "6px 12px",
    color: mode === m ? "#000" : mutedLight,
    background: mode === m ? green : "none",
    borderColor: mode === m ? green : border,
    fontWeight: 700,
  });

  // `embedded`: rendered inside CoreTierScenarios.jsx, which already provides the panel and the
  // Core Tier gate — just the body then.
  const body = (
    <>
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Track a wallet under Core Tier — Portfolio above to simulate from it.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Intro>Preview a sale or a position exit — what you'd receive and your profit or loss, before you do it.</Intro>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => switchMode("token")} style={tabStyle("token")}>Sell a token</button>
              <button type="button" onClick={() => switchMode("position")} style={tabStyle("position")}>Exit a position</button>
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

              {mode === "token" ? (
                <>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <label style={labelStyle}>Token</label>
                    <select value={token} onChange={(e) => { setToken(e.target.value); setQuantity(""); setResult(null); }} disabled={!holdings} style={inputStyle}>
                      <option value="">{holdings ? (holdings.tokens.length ? "Choose a token…" : "No tokens held freely") : holdingsError ? "Couldn't load holdings" : "Loading…"}</option>
                      {(holdings?.tokens || []).map((h) => (
                        <option key={h.tokenAddress} value={h.tokenAddress}>{`${h.symbol || h.tokenAddress.slice(0, 10)} — ${qtyFmt(h.quantity)} held`}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <label style={labelStyle}>Quantity to sell</label>
                    <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={!selectedToken} style={inputStyle} />
                    {selectedToken && (
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        {[0.25, 0.5, 1].map((f) => (
                          <button key={f} type="button" onClick={() => setFraction(f)} style={chipStyle}>{f === 1 ? "Max" : `${f * 100}%`}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <label style={labelStyle}>Position</label>
                    <select value={positionKey} onChange={(e) => { setPositionKey(e.target.value); setResult(null); }} disabled={!holdings} style={inputStyle}>
                      <option value="">{holdings ? (holdings.positions.length ? "Choose a position…" : "No pools, farms or stakes in this wallet") : holdingsError ? "Couldn't load positions" : "Loading…"}</option>
                      {(holdings?.positions || []).map((p) => (
                        <option key={p.key} value={p.key}>{`${p.label} — ${KIND_LABELS[p.kind]}${p.valueUsd != null ? ` · ${formatUsdPrice(Number(p.valueUsd))}` : ""}`}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <label style={labelStyle}>Exit (%)</label>
                    <input type="number" min="1" max="100" step="any" value={exitPct} onChange={(e) => setExitPct(e.target.value)} disabled={!selectedPosition} style={inputStyle} />
                    <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {[25, 50, 100].map((v) => (
                        <button key={v} type="button" onClick={() => setExitPct(String(v))} disabled={!selectedPosition} style={chipStyle}>{v}%</button>
                      ))}
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: mutedLight, cursor: "pointer", marginLeft: 4 }}>
                        <input type="checkbox" checked={sellToEtn} onChange={(e) => setSellToEtn(e.target.checked)} /> Sell everything to ETN
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>

            {holdingsError && <div style={{ fontSize: 12, color: errorColor }}>{holdingsError}</div>}
            {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
            <DashboardButton onClick={run} disabled={running || (mode === "token" ? !selectedToken : !selectedPosition)} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
              {running ? "Simulating…" : mode === "token" ? "Simulate sale" : "Simulate exit"}
            </DashboardButton>

            {result?.mode === "token" && <SellResult result={result.data} />}
            {result?.mode === "position" && <ExitResult result={result.data} />}
          </div>
        )}
    </>
  );
  if (embedded) return body;

  return (
    <CollapsibleCoreTierPanel icon={FlaskConical} title="Core Tier — What-If Simulator" defaultCollapsed={false}>
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="simulate a sale or a position exit before you make it — what you'd get, and the P&L in USD and ETN"
      >
        {body}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}

export function SellResult({ result }) {
  const symbol = result.symbol || "tokens";
  const impact = result.quote.priceImpactPct != null ? Number(result.quote.priceImpactPct) : null;
  const route = ROUTE_LABELS[result.quote.source]?.(result.quote) || result.quote.source;
  const realizedUsd = Number(result.realized.usd);
  const realizedEtn = result.realized.etn != null ? Number(result.realized.etn) : null;
  const cost = Number(result.costBasis.usd);
  const proceedsUsd = Number(result.proceeds.usd);
  const ls = result.lotsSummary;
  const alt = result.quote.alternative;

  return (
    <ResultCard>
      <Hero
        label={`Selling ${shortQty(result.quantity)} ${symbol}`}
        value={etnShort(result.proceeds.etn)}
        sub={`≈ ${formatUsdPrice(proceedsUsd)} · ${route}`}
      />
      <KpiRow>
        <Kpi label="Profit / loss" value={signed(realizedUsd, usdShort)} sub={cost > 0 ? `${pctText((realizedUsd / cost) * 100)} on ${usdShort(cost)} cost` : "no recorded cost"} tone={toneFor(realizedUsd)} tooltip="What you'd receive minus what those tokens cost you — oldest purchases first, the same rule as your PnL page." />
        <Kpi label="In ETN terms" value={realizedEtn == null ? "—" : signed(realizedEtn, etnFmt)} sub="vs what you paid in ETN" tone={realizedEtn == null ? undefined : toneFor(realizedEtn)} tooltip="ETN received minus what the tokens cost in ETN when you bought them — independent of ETN's own dollar price." />
        <Kpi
          label="Price impact"
          value={impact == null ? "—" : `${impact.toFixed(2)}%`}
          sub={result.quote.sellTax ? `incl. ${(result.quote.sellTax.bps / 100).toFixed(1)}% sell tax` : "incl. pool fee"}
          tone={impact == null ? undefined : impact >= 5 ? "down" : impact >= 1 ? "warn" : undefined}
          tooltip="How much less than the pool's current price you'd get for this size — includes the pool fee and any sell tax."
        />
      </KpiRow>
      {/* Only the pool's own impact counts here — a token's sell tax is charged whatever the size. */}
      {impact != null && impact - (result.quote.sellTax ? result.quote.sellTax.bps / 100 : 0) >= 5 && (
        <Callout>This sale is large for the pool — splitting it up or selling over time would likely get a better price.</Callout>
      )}
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        {ls?.count > 0 && <>From {ls.count} purchase{ls.count === 1 ? "" : "s"} ({dateFmt(ls.firstAcquiredAt)}{ls.firstAcquiredAt !== ls.lastAcquiredAt ? ` – ${dateFmt(ls.lastAcquiredAt)}` : ""}), held ~{ls.avgDaysHeld} days · </>}
        {shortQty(result.remaining.quantity)} {symbol} left · gas {result.gas ? `≈ ${smallUsdFmt(Number(result.gas.usd))}` : "n/a"}
        {alt && <> · the other pool pays {etnFmt(Number(alt.etnOut))}</>}
      </div>
      <WarningList warnings={result.warnings} />
      <AssumptionsStrip assumptions={result.assumptions} facts={["Best single pool", "FIFO cost basis"]} />
    </ResultCard>
  );
}

export function ExitResult({ result }) {
  const available = result.pnl.usd != null;
  const pnlUsd = available ? Number(result.pnl.usd) : null;
  const cost = Number(result.costBasis.usd);
  const il = result.impermanentLoss?.percent != null ? Number(result.impermanentLoss.percent) : null;
  const holdUsd = result.holdComparisonUsd != null ? Number(result.holdComparisonUsd) : null;
  const income = Number(result.incomeUsd);
  const fair = result.atFairValue;
  const fairPnl = fair?.pnlUsd != null ? Number(fair.pnlUsd) : null;
  const saleCostUsd = result.sellToEtn ? Number(fair.usd) - Number(result.total.usd) : 0;
  const worstImpact = result.received.reduce((m, r) => (r.priceImpactPct != null ? Math.max(m, Number(r.priceImpactPct)) : m), -1);

  return (
    <ResultCard>
      <Hero
        label={`Exiting ${result.exitPct}% of ${result.position.label}`}
        value={available ? signed(pnlUsd, usdShort) : "P&L unavailable"}
        pct={available && cost > 0 ? (pnlUsd / cost) * 100 : null}
        tone={available ? toneFor(pnlUsd) : undefined}
        sub={available ? `profit / loss on ${usdShort(cost)} put in${result.sellToEtn ? ", after selling to ETN" : ", at today's prices"}` : `${(result.pnl.unavailable || []).join(", ")} has no price`}
      />
      <div>
        <Eyebrow>You'd get back</Eyebrow>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {result.received.map((r) => (
            <span key={r.tokenAddress} style={{ padding: "4px 10px", borderRadius: 999, background: "rgba(255,255,255,0.05)", border: `1px solid ${border}`, fontSize: 12, color: "#fff" }}>
              {shortQty(r.amount)} {r.symbol}
              {Number(r.income) > 0 && <span style={{ color: green, fontSize: 10, marginLeft: 6 }}>+{shortQty(r.income)} earned</span>}
            </span>
          ))}
        </div>
      </div>
      <KpiRow>
        <Kpi label="1 · Remove" value={usdShort(Number(fair.usd))} sub={fairPnl == null ? "at spot" : `realized ${signed(fairPnl, usdShort)}`} tone={fairPnl == null ? undefined : toneFor(fairPnl)} tooltip="Exiting disposes of the position at today's spot prices — this is the profit or loss realized at that point, before selling anything." />
        {result.sellToEtn && (
          <Kpi label="2 · Sell to ETN" value={etnShort(result.total.etn)} sub={`≈ ${usdShort(Number(result.total.usd))}${saleCostUsd > 0.005 ? ` · selling costs ${usdShort(saleCostUsd)}` : ""}`} tone={worstImpact >= 5 ? "warn" : undefined} tooltip="Every token sold to ETN at the best pool now — pool fees, price impact and any sell tax included." />
        )}
        {income > 0 && <Kpi label="Fees & rewards" value={usdShort(income)} sub="earned, included" tone="up" />}
        {il != null && <Kpi label="Impermanent loss" value={`${il.toFixed(2)}%`} sub={holdUsd != null && holdUsd < 0 ? `holding would be +${usdShort(Math.abs(holdUsd))}` : "included above"} tone={il < -1 ? "warn" : undefined} />}
      </KpiRow>
      <div style={{ fontSize: 11, color: mutedLight }}>
        {result.lotsSummary?.count > 0 && <>Releases {result.lotsSummary.count} purchase{result.lotsSummary.count === 1 ? "" : "s"}, held ~{result.lotsSummary.avgDaysHeld} days · </>}
        gas {result.gas ? `≈ ${smallUsdFmt(Number(result.gas.usd))}${result.gas.swaps ? ` (withdraw + ${result.gas.swaps} sale${result.gas.swaps === 1 ? "" : "s"})` : ""}` : "n/a"}
      </div>
      <WarningList warnings={result.warnings} />
      <AssumptionsStrip assumptions={result.assumptions} facts={[result.sellToEtn ? "Sold at best single pool" : "Valued at spot", "FIFO cost basis"]} />
    </ResultCard>
  );
}
