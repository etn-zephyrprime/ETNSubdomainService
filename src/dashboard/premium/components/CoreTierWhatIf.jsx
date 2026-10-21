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
const pnlColor = (n) => (n >= 0 ? green : errorColor);
// Gas on Electroneum is a tiny fraction of an ETN — the 2-decimal formatters would show 0.00.
const smallEtnFmt = (n) => (n >= 0.01 ? formatEtnAmount(n) : n.toLocaleString(undefined, { maximumSignificantDigits: 3 }));
const smallUsdFmt = (n) => (n >= 0.01 ? formatUsdPrice(n) : "<$0.01");
const dateFmt = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

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

/** "Sells 3 purchases made 12 Jan – 4 Aug 2026, held 190 days on average" — the lots, condensed. */
function lotsSentence(summary, verb) {
  if (!summary || !summary.count) return null;
  const range = summary.firstAcquiredAt === summary.lastAcquiredAt ? dateFmt(summary.firstAcquiredAt) : `${dateFmt(summary.firstAcquiredAt)} – ${dateFmt(summary.lastAcquiredAt)}`;
  const zero = summary.zeroCostCount ? ` (${summary.zeroCostCount} with no recorded cost)` : "";
  return `${verb} ${summary.count} purchase${summary.count === 1 ? "" : "s"} made ${range}${zero}, held ${summary.avgDaysHeld} day${summary.avgDaysHeld === 1 ? "" : "s"} on average (oldest first, as your PnL page counts them).`;
}

function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {warnings.map((w) => (
        <div key={w} style={{ fontSize: 11, color: orange }}>⚠ {w}</div>
      ))}
    </div>
  );
}

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
            <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
              See what selling a token — or pulling out of a liquidity pool, farm or stake — would do before you do it: what ElectroSwap would pay right now including price impact, and your profit or loss in both USD and ETN. Nothing is executed.
            </div>

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

function PnlStats({ usd, usdPct, etn, afterUsd, afterEtn, usdTooltip, etnTooltip }) {
  return (
    <>
      <Stat label="Profit / loss (USD)" tooltip={usdTooltip}>
        <div style={{ fontSize: 16, fontWeight: 800, color: pnlColor(usd) }}>
          {signed(usd, formatUsdPrice)}
          {usdPct != null && <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 6 }}>({signed(usdPct, (n) => `${n.toFixed(1)}%`)})</span>}
        </div>
        <div style={{ fontSize: 11, color: mutedLight }}>after gas {signed(afterUsd, formatUsdPrice)}</div>
      </Stat>
      <Stat label="Profit / loss (ETN)" tooltip={etnTooltip}>
        <div style={{ fontSize: 16, fontWeight: 800, color: etn == null ? mutedLight : pnlColor(etn) }}>{etn == null ? "—" : signed(etn, etnFmt)}</div>
        <div style={{ fontSize: 11, color: mutedLight }}>{afterEtn == null ? "ETN history incomplete" : `after gas ${signed(afterEtn, etnFmt)}`}</div>
      </Stat>
    </>
  );
}

const ETN_PNL_TOOLTIP =
  "The same result measured in ETN: what you'd end up with in ETN, minus what you paid in ETN terms at the time you bought. Answers 'would this leave me with more ETN than I put in?' independently of ETN's own USD price.";

function SellResult({ result }) {
  const symbol = result.symbol || "tokens";
  const impact = result.quote.priceImpactPct != null ? Number(result.quote.priceImpactPct) : null;
  const route = ROUTE_LABELS[result.quote.source]?.(result.quote) || result.quote.source;
  const alt = result.quote.alternative;
  const realizedUsd = Number(result.realized.usd);
  const cost = Number(result.costBasis.usd);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>Selling {qtyFmt(result.quantity)} {symbol}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="You'd receive" tooltip="What the pool would pay right now for this exact amount, with its fee and the price impact of your trade already included.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{etnFmt(Number(result.proceeds.etn))}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>≈ {formatUsdPrice(Number(result.proceeds.usd))}</div>
        </Stat>
        <Stat label="Price impact" tooltip="How much less you'd get than the pool's current spot price for this size — includes the pool fee, and the token's own sell tax where it charges one. Large sales move the price against you.">
          <div style={{ fontSize: 16, fontWeight: 800, color: impact == null ? mutedLight : impact >= 5 ? errorColor : impact >= 1 ? orange : "#fff" }}>{impact == null ? "—" : `${impact.toFixed(2)}%`}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>{route}</div>
          {result.quote.sellTax && (
            <div style={{ fontSize: 11, color: orange }}>
              incl. {(result.quote.sellTax.bps / 100).toFixed(2)}% sell tax ({shortQty(result.quote.sellTax.tokens)} {symbol})
            </div>
          )}
        </Stat>
        <PnlStats
          usd={realizedUsd}
          usdPct={cost > 0 ? (realizedUsd / cost) * 100 : null}
          etn={result.realized.etn != null ? Number(result.realized.etn) : null}
          afterUsd={Number(result.afterGas.usd)}
          afterEtn={result.afterGas.etn != null ? Number(result.afterGas.etn) : null}
          usdTooltip="What you'd receive minus what those tokens cost you (oldest purchases first — the same rule your PnL page uses)."
          etnTooltip={ETN_PNL_TOOLTIP}
        />
      </div>
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        {lotsSentence(result.lotsSummary, "Sells")} Cost {formatUsdPrice(cost)}
        {result.costBasis.etn != null && <> ({etnFmt(Number(result.costBasis.etn))})</>}
        {" · "}Gas {result.gas ? `${smallEtnFmt(Number(result.gas.etn))} ETN (≈ ${smallUsdFmt(Number(result.gas.usd))})` : "unavailable"}
        {" · "}{shortQty(result.remaining.quantity)} {symbol} left afterwards.
        {alt && <> The other pool would pay {etnFmt(Number(alt.etnOut))}; ElectroSwap's app can also split a large sale across pools, so you may do slightly better there.</>}
      </div>
      <Warnings warnings={result.warnings} />
      <Assumptions assumptions={result.assumptions} />
    </div>
  );
}

function Assumptions({ assumptions }) {
  if (!assumptions) return null;
  const { pricedAt, etnUsd, ...rest } = assumptions;
  return (
    <div style={{ padding: "10px 12px", borderRadius: 6, border: `1px dashed ${border}`, fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
      <div style={statLabel}>Assumptions</div>
      <div>Prices live at {new Date(pricedAt).toLocaleString()} · ETN = ${Number(etnUsd).toFixed(6)}</div>
      {Object.values(rest).filter(Boolean).map((line) => (
        <div key={line}>{line}</div>
      ))}
      <div style={{ color: muted, marginTop: 4 }}>Hypothetical estimate — not a quote, not a record, and not financial or tax advice. Nothing is saved.</div>
    </div>
  );
}

function ExitResult({ result }) {
  const available = result.pnl.usd != null;
  const pnlUsd = available ? Number(result.pnl.usd) : null;
  const il = result.impermanentLoss?.percent != null ? Number(result.impermanentLoss.percent) : null;
  const holdUsd = result.holdComparisonUsd != null ? Number(result.holdComparisonUsd) : null;
  const income = Number(result.incomeUsd);
  const fair = result.atFairValue;
  const fairPnl = fair?.pnlUsd != null ? Number(fair.pnlUsd) : null;
  const backLine = result.received
    .map((r) => {
      const parts = [];
      if (Number(r.principal) > 0) parts.push(`${shortQty(r.principal)} ${r.symbol}`);
      if (Number(r.income) > 0) parts.push(`${shortQty(r.income)} ${r.symbol} ${Number(r.principal) > 0 ? "fees" : "rewards/fees"}`);
      return parts.join(" + ");
    })
    .join(" · ");
  const worstImpact = result.received.reduce((m, r) => (r.priceImpactPct != null ? Math.max(m, Number(r.priceImpactPct)) : m), -1);
  const saleCostUsd = result.sellToEtn ? Number(fair.usd) - Number(result.total.usd) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>
        Exiting {result.exitPct}% of {result.position.label}
      </div>
      <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
        <span style={{ color: muted }}>You'd get back </span>
        <span style={{ color: "#fff" }}>{backLine || "nothing"}</span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="1 · Removing it" tooltip="Exiting disposes of the position at today's spot prices and you acquire the tokens at that value. This is the profit or loss realized at that point, before selling anything.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatUsdPrice(Number(fair.usd))}</div>
          <div style={{ fontSize: 11, color: fairPnl == null ? mutedLight : pnlColor(fairPnl) }}>
            {fairPnl == null ? "P&L unavailable — a token has no price" : `realized ${signed(fairPnl, formatUsdPrice)} vs what you put in`}
          </div>
        </Stat>
        {result.sellToEtn && (
          <Stat label="2 · Then selling to ETN" tooltip="Every token the exit returns, sold to ETN at the best ElectroSwap pool right now — pool fees, price impact and any token sell tax included.">
            <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{etnFmt(Number(result.total.etn))}</div>
            <div style={{ fontSize: 11, color: mutedLight }}>
              ≈ {formatUsdPrice(Number(result.total.usd))}
              {saleCostUsd > 0.005 && ` · selling costs ${formatUsdPrice(saleCostUsd)}`}
              {worstImpact >= 0 && ` · worst impact ${worstImpact.toFixed(2)}%`}
            </div>
          </Stat>
        )}
        {available ? (
          <PnlStats
            usd={pnlUsd}
            usdPct={result.pnl.pct != null ? Number(result.pnl.pct) : null}
            etn={result.pnl.etn != null ? Number(result.pnl.etn) : null}
            afterUsd={Number(result.afterGas.usd)}
            afterEtn={result.afterGas.etn != null ? Number(result.afterGas.etn) : null}
            usdTooltip={result.sellToEtn ? "Overall: what you'd end up with in ETN (in dollars) minus what you paid for the tokens you put in. Includes fees and rewards earned, impermanent loss, and the cost of selling." : "What you'd get back, at today's prices, minus what you paid for the tokens you put in. Includes fees and rewards earned and any impermanent loss."}
            etnTooltip={ETN_PNL_TOOLTIP}
          />
        ) : (
          <Stat label="Profit / loss">
            <div style={{ fontSize: 14, fontWeight: 800, color: mutedLight }}>Unavailable</div>
            <div style={{ fontSize: 11, color: mutedLight }}>{(result.pnl.unavailable || []).join(", ")} has no price</div>
          </Stat>
        )}
      </div>
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        Cost of what you put in {formatUsdPrice(Number(result.costBasis.usd))}
        {result.costBasis.etn != null && <> ({etnFmt(Number(result.costBasis.etn))})</>}
        {income > 0 && <> · fees &amp; rewards earned {formatUsdPrice(income)}</>}
        {il != null && <> · impermanent loss {il.toFixed(2)}%{holdUsd != null && holdUsd < 0 && <> — just holding the tokens you deposited would be worth {formatUsdPrice(Math.abs(holdUsd))} more</>}</>}
        {" · "}Gas {result.gas ? `${smallEtnFmt(Number(result.gas.etn))} ETN (≈ ${smallUsdFmt(Number(result.gas.usd))})${result.gas.swaps ? `, withdraw + ${result.gas.swaps} sale${result.gas.swaps === 1 ? "" : "s"}` : ""}` : "unavailable"}.
        {result.lotsSummary?.count > 0 && <> {lotsSentence(result.lotsSummary, "Releases")}</>}
      </div>
      <Warnings warnings={result.warnings} />
      <Assumptions assumptions={result.assumptions} />
    </div>
  );
}
