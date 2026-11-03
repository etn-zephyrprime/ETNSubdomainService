import React, { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, AlertTriangle } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import DashboardPanel from "./DashboardPanel.jsx";
import { useEtnBot } from "../../hooks/useEtnBot.js";
import { EXPLORER_BASE_URL } from "../../../config.js";
import { green, gold, orange, blue, error as errorColor, muted, mutedLight, border, panel2, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const REFRESH_MS = 60000;
const label = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", color: muted };
const etn = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const signed = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : "−"}${etn(Math.abs(n))}` : "—");
const usd = (n) => (Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const switchColor = (v) => (v === "live" || v === "on" || v === "buy + sell" || v === "buy" ? green : v === "paper" ? gold : muted);

function Card({ title, value, sub, color = "#fff" }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, minWidth: 0 }}>
      <div style={label}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: mutedLight, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const th = { textAlign: "left", padding: "6px 4px", borderBottom: `1px solid ${border}`, ...label };
const td = { padding: "6px 4px", fontSize: 12, borderBottom: `1px solid rgba(255,255,255,0.04)` };

// Core Tier — ETN Bot. Owner-only (the tab only shows for ETN_BOT_VIEWERS, and the backend only answers a
// signed request from one of them): the ETN accumulator bot's live report — ETN accumulated per strategy,
// where its funds are (wallet, KuCoin, HTX), what's switched on, anything needing attention, open
// positions, and a recent-activity feed. Same figures as backend/scripts/etnBotStatus.js.
export default function CoreTierEtnBot({ wallet, getAuthParams, initialReport = null }) {
  const { getEtnBot } = useEtnBot();
  const [r, setR] = useState(initialReport); // initialReport: a report to show before the first load (tests)
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setR(await getEtnBot(wallet.account, signature, timestamp));
    } catch (err) {
      setError(err.message || "Couldn't load the bot report");
    } finally {
      setLoading(false);
    }
  }, [getAuthParams, getEtnBot, wallet.account]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
    // Once per wallet, then on a timer — not on every getAuthParams change (rebuilt each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.account]);

  const header = (
    <DashboardButton
      onClick={load}
      disabled={loading}
      style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
    >
      <RefreshCw size={12} />
      {loading ? "Refreshing…" : "Refresh"}
    </DashboardButton>
  );

  return (
    <CollapsibleCoreTierPanel icon={Bot} title="Core Tier — ETN Bot" defaultCollapsed={false} headerRight={header}>
      {error ? (
        <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
      ) : !r ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Loading the bot's books…</div>
      ) : r.empty ? (
        <div style={{ fontSize: 12, color: mutedLight }}>No {r.mode} books yet — the bot hasn't run in {r.mode} mode.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {r.issues.length > 0 && (
            <DashboardPanel accent={orange} style={{ borderColor: "rgba(255,138,61,0.5)" }}>
              {r.issues.map((m) => (
                <div key={m} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: orange, marginBottom: 4 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {m}
                </div>
              ))}
            </DashboardPanel>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <Card
              title="ETN accumulated"
              value={`${signed(r.accumulated)} ETN`}
              color={r.accumulated >= 0 ? green : errorColor}
              sub={`${((r.accumulated / r.budgetEtn) * 100).toFixed(2)}% of ${etn(r.budgetEtn)} · ${signed(r.perDay)}/day over ${r.days.toFixed(1)} days`}
            />
            <Card title="Bot wallet" value={`${etn(r.wallet.etn)} ETN`} sub={`${usd(r.wallet.USDT)} USDT · ${usd(r.wallet.USDC)} USDC`} />
            {Object.entries(r.exchanges).map(([k, x]) => (
              <Card
                key={k}
                title={`${x.name} (${x.feePct}% fee)`}
                value={x.error ? "unavailable" : `${etn(x.ETN)} ETN`}
                color={x.error ? errorColor : "#fff"}
                sub={x.error ? x.error : `${usd(x.USDT)} USDT${x.main && x.main.ETN >= 1 ? ` · ${etn(x.main.ETN)} ETN in Main` : ""}`}
              />
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries({ Hedging: r.switches.hedging, "CEX arb": r.switches.cexArb, Sweep: r.switches.sweep, "Round trip": r.switches.roundTrip, "Catch-up": r.switches.catchup, Gap: r.switches.gap, Triangles: r.switches.triangles }).map(([k, v]) => (
              <span key={k} style={{ padding: "4px 10px", borderRadius: 20, border: `1px solid ${switchColor(v)}`, color: switchColor(v), fontFamily: monoFont, fontSize: 11, fontWeight: 700 }}>
                {k}: {v}
              </span>
            ))}
          </div>

          <div>
            <div style={{ ...label, marginBottom: 6 }}>By strategy</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {r.byStrategy.map((x) => (
                  <tr key={x.key} style={{ opacity: x.on || x.gainEtn ? 1 : 0.5 }}>
                    <td style={td}>{x.label}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: monoFont, fontWeight: 700, color: x.gainEtn > 0 ? green : x.gainEtn < 0 ? errorColor : mutedLight }}>{signed(x.gainEtn)} ETN</td>
                    <td style={{ ...td, textAlign: "right", color: muted }}>{x.count} {x.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.markToMarket?.etnNow > 0 && (
              <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>
                Mark-to-market (moves with ETN's price): everything converted back to ETN now ≈ {etn(r.markToMarket.etnNow)} ETN against {etn(r.markToMarket.contributedEtn)} put in.
              </div>
            )}
          </div>

          {(r.openCatchupLots.length > 0 || r.openLots.length > 0) && (
            <div>
              <div style={{ ...label, marginBottom: 6 }}>Open positions</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Lot</th>
                    <th style={th}>Holding</th>
                    <th style={{ ...th, textAlign: "right" }}>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {r.openCatchupLots.map((l) => (
                    <tr key={`cu${l.id}`}>
                      <td style={td}>Catch-up #{l.id} ({l.kind})</td>
                      <td style={{ ...td, fontFamily: monoFont }}>{l.kind === "sell first" ? `${usd(l.usd)} ${l.stable} from ${etn(l.etn)} ETN sold` : `${etn(l.etn)} ETN bought with ${usd(l.usd)} ${l.stable}`}</td>
                      <td style={{ ...td, textAlign: "right", color: muted }}>{l.openedAt ? ago(l.openedAt) : "—"}</td>
                    </tr>
                  ))}
                  {r.openLots.map((l) => (
                    <tr key={`lot${l.id}`}>
                      <td style={td}>Sell/buyback #{l.id}</td>
                      <td style={{ ...td, fontFamily: monoFont }}>
                        {etn(l.etnSold)} ETN sold at {l.sellPrice.toPrecision(4)} · buys back {etn(l.buybackEtnNow)} now
                        {l.buybackEtnNow ? <span style={{ color: l.buybackEtnNow >= l.etnSold ? green : errorColor }}> ({(((l.buybackEtnNow / l.etnSold) - 1) * 100).toFixed(1)}%)</span> : null}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: muted }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, fontSize: 12, color: mutedLight }}>
            {r.gapBook && <div>Gap book: <span style={{ color: "#fff" }}>{usd(r.gapBook.USDT)} USDT · {usd(r.gapBook.USDC)} USDC</span></div>}
            {r.catchupPot && <div>Catch-up pot: <span style={{ color: "#fff" }}>{usd(r.catchupPot.USDT)} USDT · {usd(r.catchupPot.USDC)} USDC</span> free</div>}
            {r.hedge && <div>Hedge dollars in wallet: <span style={{ color: "#fff" }}>{usd(r.hedge.stables?.USDT || 0)} USDT · {usd(r.hedge.stables?.USDC || 0)} USDC</span></div>}
            {r.arb?.paper && <div>CEX arb paper: <span style={{ color: gold }}>+{usd(r.arb.paper.profitUsd)} over {r.arb.paper.trades}</span></div>}
            {r.hedgePaper && <div>Hedge paper: <span style={{ color: gold }}>+{usd(r.hedgePaper.profitUsd)} over {r.hedgePaper.trades}</span></div>}
            {Object.entries(r.sweeps || {}).filter(([, s]) => s.count).map(([v, s]) => (
              <div key={v}>Swept home from {v === "htx" ? "HTX" : "KuCoin"}: <span style={{ color: "#fff" }}>{etn(s.etn)} ETN</span> ({s.count}×)</div>
            ))}
          </div>

          <div>
            <div style={{ ...label, marginBottom: 6 }}>Recent activity</div>
            {r.activity.length === 0 ? (
              <div style={{ fontSize: 12, color: mutedLight }}>Nothing yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {r.activity.map((a, i) => (
                      <tr key={i}>
                        <td style={{ ...td, color: muted, whiteSpace: "nowrap" }}>{ago(a.at)}</td>
                        <td style={{ ...td, color: blue, whiteSpace: "nowrap", fontFamily: monoFont, fontSize: 11 }}>{a.kind}</td>
                        <td style={td}>{a.text}</td>
                        <td style={{ ...td, textAlign: "right", fontFamily: monoFont, fontWeight: 700, whiteSpace: "nowrap", color: a.gainEtn > 0 ? green : a.gainEtn < 0 ? errorColor : muted }}>{a.gainEtn != null ? `${signed(a.gainEtn)} ETN` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ fontSize: 10, color: muted }}>
            Bot wallet{" "}
            <a href={`${EXPLORER_BASE_URL}/address/${r.wallet.address}`} target="_blank" rel="noopener noreferrer" style={{ color: mutedLight }}>
              {r.wallet.address.slice(0, 6)}…{r.wallet.address.slice(-4)}
            </a>{" "}
            · {r.mode.toUpperCase()} since {r.startedAt.slice(0, 10)} · books updated {ago(r.updatedAt)} · report {ago(r.generatedAt)} · refreshes every minute
          </div>
        </div>
      )}
    </CollapsibleCoreTierPanel>
  );
}
