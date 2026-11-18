import React, { useCallback, useEffect, useMemo, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { RefreshCw, Network, ExternalLink } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { PNL_BACKEND_URL, EXPLORER_BASE_URL } from "../../../config.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { gold, green, muted, mutedLight, border, panel, panel2, monoFont, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const BASE = `${PNL_BACKEND_URL}/api/premium/bubblemaps`;
const GRAPH_WIDTH = 760;
const GRAPH_HEIGHT = 460;
const CLUSTER_COLORS = [green, gold, "#3ea6ff", "#c792ea", "#ff6b9d", "#4dd0e1", "#ffd54f", "#81c784", "#ba68c8"];

function nodeRadius(node) {
  return Math.max(4, Math.min(20, 3 + Math.sqrt(Math.max(0, Number(node.pct) || 0)) * 3));
}

function layoutGraph(map, showWeak) {
  const nodes = (map?.nodes || []).filter((node) => !node.excluded).map((node) => ({
    id: node.address,
    data: node,
    radius: nodeRadius(node),
  }));
  if (!nodes.length) return [];
  const available = new Set(nodes.map((node) => node.id));
  const links = (map.edges || [])
    .filter((edge) => (edge.strong || showWeak) && available.has(edge.a) && available.has(edge.b))
    .map((edge) => ({ source: edge.a, target: edge.b, strong: edge.strong, score: edge.score }));
  const simulation = forceSimulation(nodes)
    .force("link", forceLink(links).id((node) => node.id).distance((edge) => edge.strong ? 54 : 86).strength((edge) => edge.strong ? 0.28 : 0.04))
    .force("charge", forceManyBody().strength(-95))
    .force("center", forceCenter(GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2))
    .force("collide", forceCollide((node) => node.radius + 3).iterations(2))
    .stop();
  for (let tick = 0; tick < 140; tick++) simulation.tick();
  return nodes.map((node) => ({
    ...node,
    x: Math.max(node.radius + 5, Math.min(GRAPH_WIDTH - node.radius - 5, node.x)),
    y: Math.max(node.radius + 5, Math.min(GRAPH_HEIGHT - node.radius - 5, node.y)),
  }));
}

function formatBalance(value, decimals) {
  try {
    const raw = BigInt(value || "0");
    const places = Math.min(18, Math.max(0, Number(decimals) || 0));
    const unit = 10n ** BigInt(places);
    const whole = raw / unit;
    const fraction = String(raw % unit).padStart(places, "0").slice(0, 4).replace(/0+$/, "");
    return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
  } catch {
    return String(value || "0");
  }
}

function clusterColor(clusterId) {
  const index = Math.max(0, (Number(clusterId) || 1) - 1) % CLUSTER_COLORS.length;
  return CLUSTER_COLORS[index];
}

function reasonLabel(type) {
  return ({
    SAME_FUNDER: "Same first funder",
    BUNDLED_BUY: "First acquired near launch",
    TOKEN_TRANSFER: "Direct token transfer",
    ETN_TRANSFER_REPEATED: "Repeated ETN transfers",
    ETN_TRANSFER_SINGLE: "Single ETN transfer",
    SHARED_COUNTERPARTY: "Shared wallet interaction",
    TEAM: "Team wallet",
  })[type] || String(type || "").toLowerCase().replaceAll("_", " ");
}

async function responseData(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function CoreTierBubblemaps({ wallet, getAuthParams }) {
  const [catalog, setCatalog] = useState([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [map, setMap] = useState(null);
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [showWeak, setShowWeak] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingMap, setLoadingMap] = useState(false);
  const [error, setError] = useState(null);

  const authQuery = useCallback(async () => {
    const auth = await getAuthParams(AUTH_PURPOSE);
    return new URLSearchParams({
      wallet: wallet.account,
      signature: auth.signature,
      timestamp: String(auth.timestamp),
    });
  }, [getAuthParams, wallet.account]);

  const loadCatalog = useCallback(async () => {
    if (!wallet?.account) return;
    setLoadingCatalog(true);
    setError(null);
    try {
      const params = await authQuery();
      const data = await responseData(await fetch(`${BASE}/tokens?${params}`));
      setCatalog(data.tokens || []);
      const readyTokens = (data.tokens || []).filter((token) => token.map_ready);
      setSelectedToken((current) => current && readyTokens.some((token) => token.token === current) ? current : readyTokens[0]?.token || "");
    } catch (err) {
      setError(err.message || "Couldn't load the token catalog");
    } finally {
      setLoadingCatalog(false);
    }
  }, [authQuery, wallet?.account]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!selectedToken) {
      setMap(null);
      return;
    }
    let active = true;
    (async () => {
      setMap(null);
      setLoadingMap(true);
      setError(null);
      setSelectedAddress(null);
      setSelectedCluster(null);
      try {
        const params = await authQuery();
        const data = await responseData(await fetch(`${BASE}/${encodeURIComponent(selectedToken)}?${params}`));
        if (active) setMap(data);
      } catch (err) {
        if (active) setError(err.message || "Couldn't load this token map");
      } finally {
        if (active) setLoadingMap(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [authQuery, selectedToken]);

  const graphNodes = useMemo(() => layoutGraph(map, showWeak), [map, showWeak]);
  const positioned = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const tokenInfo = catalog.find((token) => token.token === selectedToken);
  const chosenNode = map?.nodes?.find((node) => node.address === selectedAddress) || null;
  const chosenCluster = map?.clusters?.find((cluster) => cluster.id === selectedCluster) || null;
  const chosenClusterMembers = chosenCluster
    ? map.nodes.filter((node) => node.cluster_id === chosenCluster.id)
    : [];
  const { resolve: resolveName } = useDisplayNames([
    ...(chosenNode ? [chosenNode.address] : []),
    ...chosenClusterMembers.slice(0, 15).map((node) => node.address),
  ]);
  const labelByAddress = useMemo(() => new Map((map?.nodes || []).map((node) => [node.address, node.label])), [map]);
  const displayName = (address) => address === selectedAddress ? resolveName(address) : labelByAddress.get(address) || resolveName(address);
  const chosenEdges = chosenNode
    ? (map?.edges || []).filter((edge) => edge.a === chosenNode.address || edge.b === chosenNode.address)
    : [];
  const excludedNodes = map?.nodes?.filter((node) => node.excluded) || [];

  return (
    <DashboardPanel accent={gold} style={{ borderColor: "rgba(232,191,76,0.4)" }}>
      <style>{`
        .bubblemap-graph{display:block;width:100%;height:auto;background:#090d0b;border:1px solid ${border};border-radius:8px;}
        .bubblemap-mobile{display:none;}
        @media (max-width:640px){.bubblemap-graph{display:none;}.bubblemap-mobile{display:block;}}
      `}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: gold, fontFamily: monoFont, fontWeight: 800, fontSize: 12, textTransform: "uppercase" }}>
          <Network size={15} /> Holder Bubblemaps
        </div>
        <button type="button" onClick={loadCatalog} disabled={loadingCatalog} style={buttonStyle()}>
          <RefreshCw size={12} /> {loadingCatalog ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p style={{ color: muted, fontSize: 12, lineHeight: 1.5, margin: "8px 0 12px" }}>
        Bubble size represents holdings. Solid links affect clusters; dotted links are weaker observed connections.
      </p>

      <label style={{ display: "block", color: mutedLight, fontSize: 11, fontFamily: monoFont, marginBottom: 5 }} htmlFor="bubblemap-token">
        Token
      </label>
      <select
        id="bubblemap-token"
        value={selectedToken}
        onChange={(event) => setSelectedToken(event.target.value)}
        style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
      >
        {!selectedToken && <option value="">{catalog.length ? "Maps are being prepared…" : loadingCatalog ? "Loading tokens…" : "No tokens found"}</option>}
        {catalog.map((token) => (
          <option key={token.token} value={token.token} disabled={!token.map_ready}>
            {[token.symbol, token.name].filter(Boolean).join(" — ") || token.token} · {token.map_ready ? `${token.score ?? "—"}/100` : "Preparing map"}
          </option>
        ))}
      </select>

      {error && <div role="alert" style={{ color: errorColor, fontSize: 12, margin: "8px 0" }}>{error}</div>}
      {loadingMap && <div style={{ color: muted, fontSize: 12, padding: 18, textAlign: "center" }}>Loading precomputed map…</div>}
      {!loadingMap && !selectedToken && catalog.length > 0 && (
        <div style={{ color: muted, fontSize: 12, padding: 18, textAlign: "center" }}>
          Maps are being prepared for {catalog.length} tokens. The analysis worker resumes automatically.
        </div>
      )}
      {map && !loadingMap && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 8, marginBottom: 12 }}>
            <Metric label="Concentration score" value={map.score == null ? "—" : `${map.score}/100`} note={map.band} />
            <Metric label="Largest cluster" value={`${map.score_parts?.largest_cluster_pct ?? 0}%`} note="of considered supply" />
            <Metric label="Bundled buys" value={`${map.score_parts?.bundled_pct ?? 0}%`} note="of considered supply" />
            <Metric label="Team holdings" value={`${map.score_parts?.team_pct ?? 0}%`} note="of considered supply" />
          </div>
          <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 10, marginBottom: 12, color: mutedLight, fontSize: 12, lineHeight: 1.5 }}>
            {map.summary}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ color: muted, fontSize: 11 }}>
              Data through block {Number(map.computed_at_block || 0).toLocaleString()} · holder snapshot refreshed every 6 hours; transfers update incrementally
            </div>
            <label style={{ color: mutedLight, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={showWeak} onChange={(event) => setShowWeak(event.target.checked)} />
              Show weak links
            </label>
          </div>

          <svg className="bubblemap-graph" viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="img" aria-label="Interactive holder cluster map">
            {(map.edges || []).filter((edge) => edge.strong || showWeak).map((edge, index) => {
              const a = positioned.get(edge.a);
              const b = positioned.get(edge.b);
              if (!a || !b) return null;
              return (
                <line
                  key={`${edge.a}-${edge.b}-${index}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={edge.strong ? clusterColor(a.data.cluster_id) : "#66706b"}
                  strokeWidth={edge.strong ? 1.7 : 1}
                  strokeDasharray={edge.strong ? undefined : "3 5"}
                  opacity={edge.strong ? 0.72 : 0.36}
                />
              );
            })}
            {graphNodes.map((node) => {
              const fill = node.data.tags?.includes("Team") ? "#3ea6ff" : clusterColor(node.data.cluster_id);
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${displayName(node.id)}, ${node.data.pct ?? 0}% of supply`}
                  onClick={() => { setSelectedAddress(node.id); setSelectedCluster(null); }}
                  onKeyDown={(event) => event.key === "Enter" && setSelectedAddress(node.id)}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={node.x} cy={node.y} r={node.radius} fill={fill} fillOpacity={0.78} stroke={selectedAddress === node.id ? "#fff" : fill} strokeWidth={selectedAddress === node.id ? 2 : 1} />
                  <title>{displayName(node.id)} · {node.data.pct ?? 0}%</title>
                </g>
              );
            })}
          </svg>

          <div className="bubblemap-mobile">
            <div style={{ color: muted, fontSize: 11, marginBottom: 8 }}>Cluster table is shown on smaller screens.</div>
            {map.clusters.map((cluster) => (
              <button
                type="button"
                key={cluster.id}
                onClick={() => { setSelectedCluster(cluster.id); setSelectedAddress(null); }}
                style={{ ...clusterRowStyle, borderLeft: `3px solid ${clusterColor(cluster.id)}` }}
              >
                <span>Cluster {cluster.id} · {cluster.members} wallet{cluster.members === 1 ? "" : "s"}</span>
                <strong>{cluster.pct}%</strong>
              </button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginTop: 12 }}>
            <div style={{ maxHeight: 190, overflow: "auto", border: `1px solid ${border}`, borderRadius: 8, padding: 8 }}>
              <div style={sectionTitle}>Clusters</div>
              {map.clusters.map((cluster) => (
                <button
                  type="button"
                  key={cluster.id}
                  onClick={() => { setSelectedCluster(cluster.id); setSelectedAddress(null); }}
                  style={{ ...clusterRowStyle, borderLeft: `3px solid ${clusterColor(cluster.id)}` }}
                >
                  <span>{cluster.members} wallet{cluster.members === 1 ? "" : "s"} · {cluster.reasons_summary.map(reasonLabel).join(", ")}</span>
                  <strong>{cluster.pct}%</strong>
                </button>
              ))}
            </div>
            <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 10, minHeight: 90 }}>
              <div style={sectionTitle}>{chosenNode ? "Wallet details" : chosenCluster ? `Cluster ${chosenCluster.id}` : "Select a wallet or cluster"}</div>
              {chosenNode && (
                <>
                  <div style={{ color: "#fff", fontWeight: 700, fontSize: 13, overflowWrap: "anywhere" }}>                  {displayName(chosenNode.address)}</div>
                  <div style={{ fontFamily: monoFont, color: muted, fontSize: 10, overflowWrap: "anywhere", margin: "3px 0 8px" }}>{chosenNode.address}</div>
                  <div style={{ color: mutedLight, fontSize: 11 }}>
                    {formatBalance(chosenNode.balance, tokenInfo?.decimals)} {tokenInfo?.symbol || ""} · {chosenNode.pct ?? "—"}% of supply
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
                    {(chosenNode.tags || []).map((tag) => <span key={tag} style={tagStyle}>{tag}</span>)}
                    {chosenNode.excluded && <span style={tagStyle}>{chosenNode.exclusion_reason}</span>}
                  </div>
                  {chosenEdges.map((edge) => (
                    <div key={`${edge.a}-${edge.b}`} style={{ color: muted, fontSize: 10, marginTop: 4 }}>
                      {edge.reasons.map((reason) => `${reasonLabel(reason.type)}: ${reason.detail}`).join(" · ")}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11 }}>
                    <a href={`${EXPLORER_BASE_URL}/address/${chosenNode.address}`} target="_blank" rel="noreferrer" style={linkStyle}>Explorer <ExternalLink size={11} /></a>
                    <a href={`/pnl?wallet=${encodeURIComponent(chosenNode.address)}`} style={linkStyle}>PnL tools</a>
                  </div>
                </>
              )}
              {chosenCluster && (
                <>
                  <div style={{ color: mutedLight, fontSize: 11, marginBottom: 6 }}>
                    {chosenCluster.members} wallet{chosenCluster.members === 1 ? "" : "s"} hold {chosenCluster.pct}% of considered supply.
                    {" "}Reasons: {chosenCluster.reasons_summary.map(reasonLabel).join(", ")}.
                  </div>
                  {chosenClusterMembers.map((node) => (
                    <button key={node.address} type="button" onClick={() => { setSelectedAddress(node.address); setSelectedCluster(null); }} style={memberRowStyle}>
                      {displayName(node.address)} <span>{node.pct ?? "—"}%</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          {excludedNodes.length > 0 && (
            <details style={{ marginTop: 12, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
              <summary style={{ color: muted, fontSize: 11, cursor: "pointer" }}>Excluded addresses ({excludedNodes.length})</summary>
              <div style={{ display: "grid", gap: 5, maxHeight: 180, overflow: "auto", marginTop: 8 }}>
                {excludedNodes.map((node) => (
                  <div key={node.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#858b87", fontSize: 10, opacity: 0.72 }}>
                    <span>{displayName(node.address)}</span>
                    <span>{node.exclusion_reason}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div style={{ marginTop: 12, color: muted, fontSize: 10, lineHeight: 1.5 }}>
            Informational only, not financial advice. On-chain links are signals for review and do not establish common ownership.
          </div>
        </>
      )}
    </DashboardPanel>
  );
}

function Metric({ label, value, note }) {
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 9, background: panel }}>
      <div style={{ color: muted, fontSize: 9, fontFamily: monoFont, textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: "#fff", fontSize: 17, fontWeight: 800, marginTop: 3 }}>{value}</div>
      <div style={{ color: muted, fontSize: 10 }}>{note}</div>
    </div>
  );
}

function buttonStyle() {
  return { display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${border}`, borderRadius: 6, background: panel2, color: mutedLight, padding: "6px 9px", fontFamily: monoFont, fontSize: 10, fontWeight: 700, cursor: "pointer" };
}

const inputStyle = { background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 12, boxSizing: "border-box" };
const sectionTitle = { color: muted, fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 7 };
const clusterRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", marginBottom: 5, padding: "7px 8px", border: `1px solid ${border}`, borderRadius: 5, background: panel, color: mutedLight, fontSize: 10, cursor: "pointer" };
const memberRowStyle = { display: "flex", justifyContent: "space-between", width: "100%", padding: "4px 0", border: 0, background: "transparent", color: mutedLight, fontSize: 10, cursor: "pointer" };
const tagStyle = { border: `1px solid ${border}`, borderRadius: 10, padding: "2px 6px", color: muted, fontSize: 9 };
const linkStyle = { display: "inline-flex", alignItems: "center", gap: 3, color: green, textDecoration: "none", fontWeight: 700 };
