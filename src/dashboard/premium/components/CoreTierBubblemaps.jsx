import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { RefreshCw, Network, ExternalLink } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { PNL_BACKEND_URL, EXPLORER_BASE_URL } from "../../../config.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { getTokenLogoUrl } from "../../utils/tokenLogos.js";
import { gold, green, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const BASE = `${PNL_BACKEND_URL}/api/premium/bubblemaps`;
const MAP_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GRAPH_WIDTH = 760;
const GRAPH_HEIGHT = 460;
const MAX_NODE_RADIUS = 22;
const MIN_NODE_HIT_RADIUS = 5;
const CLUSTER_COLORS = ["#26d9c1", "#e34bb7", "#668cff", "#ae7cff", "#f49a5b", "#48bed3"];

function nodeSupplyShare(node) {
  const share = node.supply_share == null ? Number.NaN : Number(node.supply_share);
  if (Number.isFinite(share) && share >= 0) return share;
  const pct = Number(node.pct);
  return Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
}

function clusterSupplyPercent(map, cluster) {
  if (cluster.supply_pct != null && Number.isFinite(Number(cluster.supply_pct))) return Number(cluster.supply_pct);
  return (map?.nodes || [])
    .filter((node) => !node.excluded && node.cluster_id === cluster.id)
    .reduce((sum, node) => sum + nodeSupplyShare(node), 0) * 100;
}

function layoutGraph(map, showWeak) {
  const nodes = (map?.nodes || []).filter((node) => !node.excluded).map((node) => ({
    id: node.address,
    data: node,
    supplyShare: nodeSupplyShare(node),
  }));
  if (!nodes.length) return [];
  const maxSupplyShare = Math.max(...nodes.map((node) => node.supplyShare));
  for (const node of nodes) {
    // Square-root radius makes bubble area proportional to total-supply share.
    node.radius = maxSupplyShare > 0 ? MAX_NODE_RADIUS * Math.sqrt(node.supplyShare / maxSupplyShare) : 0;
    node.hitRadius = Math.max(MIN_NODE_HIT_RADIUS, node.radius);
  }
  const available = new Set(nodes.map((node) => node.id));
  const links = (map.edges || [])
    .filter((edge) => (edge.strong || showWeak) && available.has(edge.a) && available.has(edge.b))
    .map((edge) => ({ source: edge.a, target: edge.b, strong: edge.strong, score: edge.score }));
  const strongLinks = links.filter((edge) => edge.strong);
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  strongLinks.forEach((edge) => union(edge.source, edge.target));
  const components = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    const members = components.get(root) || [];
    members.push(node);
    components.set(root, members);
  }
  const componentOrder = [...components.values()]
    .map((members) => ({
      members,
      supply: members.reduce((sum, node) => sum + node.supplyShare, 0),
    }))
    .sort((a, b) => b.supply - a.supply || b.members.length - a.members.length);
  const componentTargets = new Map();
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT / 2;
  const maxRadius = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) * 0.39;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  componentOrder.forEach((component, index) => {
    const rank = index / Math.max(1, componentOrder.length - 1);
    const angle = index * goldenAngle - Math.PI / 2;
    const radius = index === 0 ? 0 : maxRadius * (0.18 + 0.82 * Math.sqrt(rank));
    const target = {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius * GRAPH_HEIGHT / GRAPH_WIDTH,
    };
    component.members.forEach((node) => componentTargets.set(node.id, target));
  });
  componentOrder.forEach((component) => {
    const target = componentTargets.get(component.members[0].id);
    component.members
      .sort((a, b) => b.supplyShare - a.supplyShare)
      .forEach((node, index) => {
        const angle = index * goldenAngle;
        const localRadius = index === 0 ? 0 : Math.min(74, 12 + Math.sqrt(index) * 13);
        node.x = target.x + Math.cos(angle) * localRadius;
        node.y = target.y + Math.sin(angle) * localRadius;
      });
    component.members.forEach((node) => {
      node.clusterSize = component.members.length;
    });
  });
  const simulation = forceSimulation(nodes)
    .force("link", forceLink(strongLinks).id((node) => node.id).distance(30).strength(0.42))
    .force("charge", forceManyBody().strength(-24))
    .force("component-x", forceX((node) => componentTargets.get(node.id).x).strength(0.24))
    .force("component-y", forceY((node) => componentTargets.get(node.id).y).strength(0.24))
    .force("collide", forceCollide((node) => node.radius + 4).iterations(3))
    .stop();
  for (let tick = 0; tick < 220; tick++) simulation.tick();
  return nodes.map((node) => ({
    ...node,
    x: Math.max(node.hitRadius + 2, Math.min(GRAPH_WIDTH - node.hitRadius - 2, node.x)),
    y: Math.max(node.hitRadius + 2, Math.min(GRAPH_HEIGHT - node.hitRadius - 2, node.y)),
  }));
}

function buildConnectedClusters(map, showWeak) {
  const nodes = (map?.nodes || []).filter((node) => !node.excluded);
  const nodeByAddress = new Map(nodes.map((node) => [node.address, node]));
  const strongClusters = (map?.clusters || [])
    .filter((cluster) => cluster.members > 1)
    .map((cluster) => ({
      ...cluster,
      strength: "strong",
      memberAddresses: nodes.filter((node) => node.cluster_id === cluster.id).map((node) => node.address),
    }));
  if (!showWeak) return strongClusters;

  const weakEdges = (map?.edges || []).filter((edge) =>
    !edge.strong && nodeByAddress.has(edge.a) && nodeByAddress.has(edge.b)
  );
  const parent = new Map(nodes.map((node) => [node.address, node.address]));
  const find = (address) => {
    let root = address;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  weakEdges.forEach((edge) => union(edge.a, edge.b));
  const weakGroups = new Map();
  for (const edge of weakEdges) {
    const root = find(edge.a);
    const members = weakGroups.get(root) || new Set();
    members.add(edge.a);
    members.add(edge.b);
    weakGroups.set(root, members);
  }
  const weakClusters = [...weakGroups.values()]
    .filter((members) => members.size > 1)
    .map((members, index) => {
      const memberAddresses = [...members];
      const edges = weakEdges.filter((edge) => members.has(edge.a) && members.has(edge.b));
      const supplyPct = memberAddresses.reduce((sum, address) => sum + Number(nodeByAddress.get(address)?.pct || 0), 0);
      const reasons = [...new Set(edges.flatMap((edge) => (edge.reasons || []).map((reason) => reason.type)))];
      return {
        id: `weak-${index + 1}`,
        members: memberAddresses.length,
        pct: supplyPct,
        supply_pct: supplyPct,
        strength: "weak",
        memberAddresses,
        reasons_summary: reasons.length ? reasons : ["SHARED_COUNTERPARTY"],
      };
    });
  return [...strongClusters, ...weakClusters].sort((a, b) => b.supply_pct - a.supply_pct);
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
  const orbGradientId = `bubblemap-orb-${useId().replaceAll(":", "")}`;
  const tokenLogoClipId = `bubblemap-token-logo-${useId().replaceAll(":", "")}`;
  const [catalog, setCatalog] = useState([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [map, setMap] = useState(null);
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [showWeak, setShowWeak] = useState(true);
  const [mapZoom, setMapZoom] = useState(1);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingMap, setLoadingMap] = useState(false);
  const [error, setError] = useState(null);
  const [graphNodes, setGraphNodes] = useState([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  const authQuery = useCallback(async () => {
    const auth = await authRef.current(AUTH_PURPOSE);
    return new URLSearchParams({
      wallet: wallet.account,
      signature: auth.signature,
      timestamp: String(auth.timestamp),
    });
  }, [wallet.account]);

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

  const refresh = useCallback(() => {
    loadCatalog();
    setRefreshVersion((current) => current + 1);
  }, [loadCatalog]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!wallet?.account) return undefined;
    const interval = setInterval(refresh, MAP_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh, wallet?.account]);

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
  }, [authQuery, selectedToken, refreshVersion]);

  useEffect(() => {
    setGraphNodes(layoutGraph(map, showWeak));
    setMapZoom(1);
  }, [map, showWeak]);
  const positioned = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const tokenInfo = catalog.find((token) => token.token === selectedToken);
  const tokenLogoUrl = getTokenLogoUrl(selectedToken);
  const chosenNode = map?.nodes?.find((node) => node.address === selectedAddress) || null;
  const chosenCluster = map?.clusters?.find((cluster) => cluster.id === selectedCluster) || null;
  const chosenMapClusterMembers = chosenCluster
    ? map.nodes.filter((node) => node.cluster_id === chosenCluster.id)
    : [];
  const { resolve: resolveName } = useDisplayNames([
    ...(chosenNode ? [chosenNode.address] : []),
    ...chosenMapClusterMembers.slice(0, 15).map((node) => node.address),
  ]);
  const labelByAddress = useMemo(() => new Map((map?.nodes || []).map((node) => [node.address, node.label])), [map]);
  const displayName = (address) => address === selectedAddress ? resolveName(address) : labelByAddress.get(address) || resolveName(address);
  const chosenEdges = chosenNode
    ? (map?.edges || []).filter((edge) => edge.a === chosenNode.address || edge.b === chosenNode.address)
    : [];
  const excludedNodes = map?.nodes?.filter((node) => node.excluded) || [];
  const mappedNodes = map?.nodes?.filter((node) => !node.excluded) || [];
  const largestCluster = [...(map?.clusters || [])].sort((a, b) => b.pct - a.pct)[0];
  const largestClusterMembers = Number(map?.calibration?.largest_cluster_holders ?? largestCluster?.members ?? 0);
  const largestClusterSupplyPercent = largestCluster ? clusterSupplyPercent(map, largestCluster) : 0;
  const largestClusterReasons = (largestCluster?.reasons_summary || [])
    .filter((reason) => reason !== "No detected link")
    .map(reasonLabel)
    .join(", ");
  const generatedSummary = largestCluster
    ? largestClusterMembers > 1
      ? `${largestClusterMembers} linked wallets hold ${largestClusterSupplyPercent.toFixed(2)}% of total supply (${largestCluster.pct}% of considered supply)${largestClusterReasons ? ` (${largestClusterReasons})` : ""}.`
      : `The largest individual holding is ${largestClusterSupplyPercent.toFixed(2)}% of total supply (${largestCluster.pct}% of considered supply).`
    : map?.summary;
  const displayedSummary = map?.score_parts?.largest_cluster_supply_pct == null ? generatedSummary : map?.summary || generatedSummary;
  const connectedClusters = useMemo(() => buildConnectedClusters(map, showWeak), [map, showWeak]);
  const orderedClusters = [...connectedClusters].sort((a, b) => b.pct - a.pct);
  const chosenConnectedCluster = connectedClusters.find((cluster) => cluster.id === selectedCluster) || null;
  const chosenClusterMembers = chosenConnectedCluster
    ? map.nodes.filter((node) => chosenConnectedCluster.memberAddresses.includes(node.address))
    : [];
  const beginDrag = (event, node) => {
    if (event.button !== undefined && event.button !== 0) return;
    const svg = event.currentTarget.ownerSVGElement;
    const bounds = svg?.getBoundingClientRect();
    if (!bounds?.width || !bounds?.height) return;
    const x = GRAPH_WIDTH / 2 + ((event.clientX - bounds.left) * GRAPH_WIDTH / bounds.width - GRAPH_WIDTH / 2) / mapZoom;
    const y = GRAPH_HEIGHT / 2 + ((event.clientY - bounds.top) * GRAPH_HEIGHT / bounds.height - GRAPH_HEIGHT / 2) / mapZoom;
    suppressClickRef.current = false;
    dragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      offsetX: node.x - x,
      offsetY: node.y - y,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveBubble = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = GRAPH_WIDTH / 2 + ((event.clientX - bounds.left) * GRAPH_WIDTH / bounds.width - GRAPH_WIDTH / 2) / mapZoom + drag.offsetX;
    const y = GRAPH_HEIGHT / 2 + ((event.clientY - bounds.top) * GRAPH_HEIGHT / bounds.height - GRAPH_HEIGHT / 2) / mapZoom + drag.offsetY;
    setGraphNodes((current) => current.map((node) => node.id !== drag.id ? node : {
      ...node,
      x: Math.max(node.hitRadius + 2, Math.min(GRAPH_WIDTH - node.hitRadius - 2, x)),
      y: Math.max(node.hitRadius + 2, Math.min(GRAPH_HEIGHT - node.hitRadius - 2, y)),
    }));
  };
  const endDrag = (event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    suppressClickRef.current = dragRef.current.moved;
    dragRef.current = null;
  };
  const zoomMap = (event) => {
    event.preventDefault();
    setMapZoom((current) => Math.max(1, Math.min(3, current * (event.deltaY < 0 ? 1.12 : 0.9))));
  };
  const adjustZoom = (amount) => {
    setMapZoom((current) => Math.max(1, Math.min(3, current + amount)));
  };

  return (
    <DashboardPanel accent={gold} style={{ padding: 12, borderColor: "rgba(232,191,76,0.4)", background: "#0b1014" }}>
      <style>{`
        .bubblemap-terminal{display:grid;gap:12px;color:#d6e0de;}
        .bubblemap-topbar,.bubblemap-tokenbar,.bubblemap-map-heading,.bubblemap-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;}
        .bubblemap-zoom-controls{display:flex;align-items:center;gap:4px;}
        .bubblemap-zoom-controls button{width:26px;height:24px;padding:0;border:1px solid #26343a;border-radius:5px;background:#0e1519;color:#b9c5c1;font:700 11px ${monoFont};cursor:pointer;}
        .bubblemap-zoom-controls button:hover{border-color:${green};color:#f3f6f5;}
        .bubblemap-topbar{min-height:32px;}
        .bubblemap-brand{display:flex;align-items:center;gap:10px;}
        .bubblemap-brand-icon{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(232,191,76,.32);border-radius:9px;background:rgba(232,191,76,.08);color:${gold};}
        .bubblemap-kicker,.bubblemap-label{color:#78868b;font:800 9px ${monoFont};letter-spacing:.1em;text-transform:uppercase;}
        .bubblemap-title{margin-top:3px;color:#edf2f0;font:700 14px ${monoFont};letter-spacing:.04em;text-transform:uppercase;}
        .bubblemap-actions{display:flex;align-items:center;gap:8px;}
        .bubblemap-status{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid #26343a;border-radius:6px;color:#9aa8aa;font:700 9px ${monoFont};text-transform:uppercase;}
        .bubblemap-status:before{content:"";width:6px;height:6px;border-radius:50%;background:${green};box-shadow:0 0 8px ${green};}
        .bubblemap-refresh{min-height:30px;}
        .bubblemap-tokenbar{padding:14px;border:1px solid #26343a;border-radius:8px;background:linear-gradient(110deg,rgba(24,187,26,.07),transparent 45%),#0e1519;}
        .bubblemap-token-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:5px 0;}
        .bubblemap-token-symbol{color:#f3f6f5;font-size:22px;font-weight:800;letter-spacing:-.03em;}
        .bubblemap-token-name{color:#859397;font-size:12px;}
        .bubblemap-token-address{color:#748287;font:10px ${monoFont};text-decoration:none;}
        .bubblemap-token-address:hover{color:${gold};}
        .bubblemap-selector{width:min(100%,300px);}
        .bubblemap-selector select{width:100%;margin-top:5px;}
        .bubblemap-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;}
        .bubblemap-stat{min-width:0;padding:10px;border:1px solid #26343a;border-radius:7px;background:#0d1418;}
        .bubblemap-stat-value{margin-top:5px;color:#f1f5f4;font-size:17px;font-weight:800;line-height:1.1;overflow-wrap:anywhere;}
        .bubblemap-stat-note{margin-top:4px;color:#778589;font-size:10px;}
        .bubblemap-summary{padding:10px 12px;border:1px solid rgba(24,187,26,.18);border-left:2px solid ${green};border-radius:6px;background:rgba(24,187,26,.035);color:#aab8b6;font-size:11px;line-height:1.5;}
        .bubblemap-main{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-items:stretch;}
        .bubblemap-map-card,.bubblemap-side-card{min-width:0;border:1px solid #26343a;border-radius:8px;background:#0c1216;}
        .bubblemap-map-card{padding:10px;}
        .bubblemap-map-heading{margin-bottom:8px;}
        .bubblemap-map-title,.bubblemap-section-title{color:#d9e2e0;font:800 10px ${monoFont};letter-spacing:.07em;text-transform:uppercase;}
        .bubblemap-map-subtitle{margin-top:4px;color:#778589;font-size:10px;}
        .bubblemap-graph{display:block;width:100%;height:auto;background-color:#07100a;background-image:radial-gradient(ellipse at 50% 44%,rgba(24,187,26,.14),transparent 68%),linear-gradient(180deg,#0a160d,#050b07);border:1px solid #1b3525;border-radius:6px;touch-action:none;}
        .bubblemap-node{cursor:grab;touch-action:none;}
        .bubblemap-node:active{cursor:grabbing;}
        .bubblemap-node:focus-visible{outline:none;filter:drop-shadow(0 0 9px rgba(255,255,255,.8));}
        .bubblemap-node:hover .bubblemap-node-core{stroke:#dbe9ff;stroke-width:1.6;stroke-opacity:.95;}
        .bubblemap-toggle{display:flex;align-items:center;gap:6px;color:#aab6b7;font-size:10px;white-space:nowrap;}
        .bubblemap-map-meta{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:8px;color:#748287;font:9px ${monoFont};}
        .bubblemap-sidebar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-height:0;}
        .bubblemap-side-card{display:flex;flex-direction:column;padding:10px;}
        .bubblemap-section-heading{margin-bottom:8px;}
        .bubblemap-count{color:#718085;font:9px ${monoFont};}
        .bubblemap-clusters{display:grid;gap:5px;max-height:250px;overflow:auto;padding-right:2px;}
        .bubblemap-cluster-row{display:grid;grid-template-columns:9px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:8px;border:1px solid #202c31;border-radius:6px;background:#0e161a;color:#c3cecb;text-align:left;cursor:pointer;}
        .bubblemap-cluster-row:hover,.bubblemap-cluster-row[aria-pressed="true"]{border-color:rgba(232,191,76,.5);background:#141c20;}
        .bubblemap-cluster-dot{width:8px;height:8px;border-radius:50%;}
        .bubblemap-cluster-name{font-size:10px;font-weight:700;}
        .bubblemap-cluster-note{display:block;margin-top:3px;color:#778589;font-size:9px;line-height:1.35;}
        .bubblemap-cluster-share{color:#ecf2ef;font:700 11px ${monoFont};}
        .bubblemap-selection{flex:1;min-height:0;overflow:auto;color:#aebbb8;}
        .bubblemap-selection-name{color:#eff4f2;font-size:13px;font-weight:750;overflow-wrap:anywhere;}
        .bubblemap-selection-address{margin:4px 0 9px;color:#768489;font:9px ${monoFont};overflow-wrap:anywhere;}
        .bubblemap-selection-balance{font-size:11px;}
        .bubblemap-member-row{display:flex;justify-content:space-between;gap:8px;width:100%;padding:7px 0;border:0;border-bottom:1px solid #202b30;background:transparent;color:#aebbb8;font-size:10px;text-align:left;cursor:pointer;}
        .bubblemap-member-row:hover{color:#fff;}
        .bubblemap-mobile-note{display:none;}
        .bubblemap-empty{padding:16px 8px;color:#778589;font-size:10px;line-height:1.5;}
        .bubblemap-loading{padding:20px;text-align:center;color:#91a09e;font-size:11px;}
        .bubblemap-error{padding:8px 10px;border:1px solid rgba(255,107,107,.25);border-radius:6px;background:rgba(255,107,107,.06);color:${errorColor};font-size:11px;}
        .bubblemap-excluded{margin-top:2px;border-top:1px solid #26343a;padding-top:10px;}
        .bubblemap-excluded summary{color:#859397;font:700 9px ${monoFont};letter-spacing:.04em;text-transform:uppercase;cursor:pointer;}
        @media(max-width:980px){.bubblemap-stats{grid-template-columns:repeat(3,minmax(0,1fr));}.bubblemap-side-card{min-height:220px;}}
        @media(max-width:640px){.bubblemap-topbar{align-items:flex-start;}.bubblemap-status{display:none;}.bubblemap-tokenbar{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:11px;}.bubblemap-selector{width:100%;}.bubblemap-token-symbol{font-size:19px;}.bubblemap-stats{grid-template-columns:repeat(2,minmax(0,1fr));}.bubblemap-graph{display:none;}.bubblemap-mobile-note{display:block;margin:4px 0 8px;color:#778589;font-size:10px;}.bubblemap-sidebar{grid-template-columns:minmax(0,1fr);}.bubblemap-side-card{min-height:0;}.bubblemap-clusters{max-height:280px;}.bubblemap-map-meta{align-items:flex-start;flex-direction:column;}.bubblemap-map-heading{align-items:flex-start;flex-direction:column;}}
      `}</style>
      <div className="bubblemap-terminal">
        <div className="bubblemap-topbar">
          <div className="bubblemap-brand">
            <div className="bubblemap-brand-icon"><Network size={17} /></div>
            <div>
              <div className="bubblemap-kicker">Core tier · Electroneum</div>
              <div className="bubblemap-title">Holder network</div>
            </div>
          </div>
          <div className="bubblemap-actions">
            <span className="bubblemap-status">Cached analysis</span>
            <button type="button" className="bubblemap-refresh" onClick={refresh} disabled={loadingCatalog || loadingMap} style={buttonStyle()}>
              <RefreshCw size={12} /> {loadingCatalog || loadingMap ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="bubblemap-tokenbar">
          <div>
            <div className="bubblemap-kicker">Asset profile / holder distribution</div>
            <div className="bubblemap-token-title">
              <span className="bubblemap-token-symbol">{tokenInfo?.symbol || (selectedToken ? "Token" : "Choose a token")}</span>
              {tokenInfo?.name && <span className="bubblemap-token-name">{tokenInfo.name}</span>}
            </div>
            {selectedToken && (
              <a className="bubblemap-token-address" href={`${EXPLORER_BASE_URL}/token/${selectedToken}`} target="_blank" rel="noreferrer">
                {selectedToken.slice(0, 10)}…{selectedToken.slice(-8)} <ExternalLink size={10} />
              </a>
            )}
          </div>
          <label className="bubblemap-selector">
            <span className="bubblemap-label">Analyzed asset</span>
            <select
              id="bubblemap-token"
              value={selectedToken}
              onChange={(event) => setSelectedToken(event.target.value)}
              style={inputStyle}
            >
              {!selectedToken && <option value="">{catalog.length ? "Maps are being prepared…" : loadingCatalog ? "Loading tokens…" : "No tokens found"}</option>}
              {catalog.map((token) => (
                <option key={token.token} value={token.token} disabled={!token.map_ready}>
                  {[token.symbol, token.name].filter(Boolean).join(" — ") || token.token} · {token.map_ready ? `${token.score ?? "—"}/100` : "Preparing map"}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div role="alert" className="bubblemap-error">{error}</div>}
        {loadingMap && <div className="bubblemap-loading">Loading precomputed holder map…</div>}
        {!loadingMap && !selectedToken && catalog.length > 0 && (
          <div className="bubblemap-empty">
            Maps are being prepared for {catalog.length} tokens. The analysis worker resumes automatically.
          </div>
        )}
        {map && !loadingMap && (
          <>
            <div className="bubblemap-stats">
              <Metric label="Concentration score" value={map.score == null ? "—" : `${map.score}/100`} note={map.band} />
              <Metric label="Wallets mapped" value={mappedNodes.length.toLocaleString()} note="eligible holders" />
              <Metric label={largestClusterMembers > 1 ? "Largest cluster" : "Largest holder"} value={`${largestClusterSupplyPercent.toFixed(2)}%`} note="of total supply" />
              <Metric label="Bundled buys" value={`${map.score_parts?.bundled_pct ?? 0}%`} note="of considered supply" />
              <Metric label="Team holdings" value={`${map.score_parts?.team_pct ?? 0}%`} note="of considered supply" />
            </div>
            <div className="bubblemap-summary">
              <span className="bubblemap-label">Signal summary&nbsp; </span>{displayedSummary}
            </div>

            <div className="bubblemap-main">
              <section className="bubblemap-map-card">
                <div className="bubblemap-map-heading">
                  <div>
                    <div className="bubblemap-map-title">Holder map</div>
                    <div className="bubblemap-map-subtitle">Bubble size tracks share of supply · drag to reposition</div>
                  </div>
                  <label className="bubblemap-toggle">
                    <input type="checkbox" checked={showWeak} onChange={(event) => setShowWeak(event.target.checked)} />
                    Show weak links
                  </label>
                  <div className="bubblemap-zoom-controls" aria-label="Map zoom controls">
                    <button type="button" onClick={() => adjustZoom(-0.25)} aria-label="Zoom out">−</button>
                    <button type="button" onClick={() => setMapZoom(1)} aria-label="Reset zoom">{Math.round(mapZoom * 100)}%</button>
                    <button type="button" onClick={() => adjustZoom(0.25)} aria-label="Zoom in">+</button>
                  </div>
                </div>
                <div className="bubblemap-mobile-note">Explore the ranked cluster list below; the interactive canvas is best viewed on a wider screen.</div>
                <svg
                  className="bubblemap-graph"
                  viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                  role="img"
                  aria-label="Interactive holder cluster map"
                  onPointerMove={moveBubble}
                  onWheel={zoomMap}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onLostPointerCapture={endDrag}
                >
                  <defs>
                    <radialGradient id={orbGradientId} cx="30%" cy="25%" r="78%">
                      <stop offset="0%" stopColor="#52698f" stopOpacity="0.88" />
                      <stop offset="48%" stopColor="#263653" stopOpacity="0.94" />
                      <stop offset="100%" stopColor="#0b1220" />
                    </radialGradient>
                    <clipPath id={tokenLogoClipId} clipPathUnits="objectBoundingBox">
                      <circle cx="0.5" cy="0.5" r="0.5" />
                    </clipPath>
                  </defs>
                  <g transform={`translate(${GRAPH_WIDTH / 2} ${GRAPH_HEIGHT / 2}) scale(${mapZoom}) translate(${-GRAPH_WIDTH / 2} ${-GRAPH_HEIGHT / 2})`}>
                  {(map.edges || []).filter((edge) => edge.strong || showWeak).map((edge, index) => {
                    const a = positioned.get(edge.a);
                    const b = positioned.get(edge.b);
                    if (!a || !b) return null;
                    return (
                      <g key={`${edge.a}-${edge.b}-${index}`} pointerEvents="none">
                        {edge.strong && (
                          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={clusterColor(a.data.cluster_id)} strokeWidth={4} opacity={0.1} />
                        )}
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke={edge.strong ? clusterColor(a.data.cluster_id) : "#66706b"}
                          strokeWidth={edge.strong ? 1.25 : 0.8}
                          strokeDasharray={edge.strong ? undefined : "2 5"}
                          opacity={edge.strong ? 0.62 : 0.28}
                        />
                      </g>
                    );
                  })}
                  {graphNodes.map((node) => {
                    const selected = selectedAddress === node.id;
                    const clustered = node.clusterSize > 1;
                    const accent = node.data.tags?.includes("Team")
                      ? "#73b8ff"
                      : clustered
                        ? clusterColor(node.data.cluster_id)
                        : "#58749b";
                    const label = selected ? displayName(node.id) : "";
                    const shortLabel = label.length > 20 ? `${label.slice(0, 19)}…` : label;
                    const labelWidth = Math.max(142, Math.min(220, shortLabel.length * 6.4 + 66));
                    const labelOnRight = node.x + node.radius + labelWidth + 8 <= GRAPH_WIDTH;
                    const labelX = labelOnRight
                      ? node.x + node.radius + 8
                      : Math.max(6, node.x - node.radius - labelWidth - 8);
                    const labelY = Math.max(18, Math.min(GRAPH_HEIGHT - 18, node.y));
                    return (
                      <g
                        key={node.id}
                        className="bubblemap-node"
                        role="button"
                        tabIndex={0}
                        aria-label={`${displayName(node.id)}, ${node.data.pct ?? 0}% of supply`}
                        onPointerDown={(event) => beginDrag(event, node)}
                        onClick={() => {
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                          }
                          setSelectedAddress(node.id);
                          setSelectedCluster(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedAddress(node.id);
                            setSelectedCluster(null);
                          }
                        }}
                        style={selected ? { filter: `drop-shadow(0 0 9px ${accent}80)` } : undefined}
                      >
                        <circle cx={node.x} cy={node.y} r={node.hitRadius} fill="transparent" pointerEvents="all" />
                        <circle cx={node.x} cy={node.y} r={node.radius * 1.65} fill={accent} fillOpacity={selected ? 0.07 : clustered ? 0.035 : 0.018} />
                        <circle cx={node.x} cy={node.y} r={node.radius * 1.25} fill={accent} fillOpacity={selected ? 0.18 : clustered ? 0.12 : 0.06} />
                        <circle
                          className="bubblemap-node-core"
                          cx={node.x}
                          cy={node.y}
                          r={node.radius}
                          fill={`url(#${orbGradientId})`}
                          stroke={selected ? "#f4f8ff" : accent}
                          strokeOpacity={selected ? 1 : clustered ? 0.84 : 0.5}
                          strokeWidth={selected ? 2 : node.radius * 0.08}
                        />
                        {tokenLogoUrl && node.radius >= 8 && (
                          <image
                            href={tokenLogoUrl}
                            x={node.x - node.radius * 0.58}
                            y={node.y - node.radius * 0.58}
                            width={node.radius * 1.16}
                            height={node.radius * 1.16}
                            preserveAspectRatio="xMidYMid slice"
                            opacity={selected ? 0.95 : 0.8}
                            clipPath={`url(#${tokenLogoClipId})`}
                            pointerEvents="none"
                          />
                        )}
                        <circle cx={node.x - node.radius * 0.32} cy={node.y - node.radius * 0.36} r={node.radius * 0.22} fill="#e2ecff" fillOpacity={selected ? 0.6 : 0.3} pointerEvents="none" />
                        {selected && (
                          <g className="bubblemap-node-label" pointerEvents="none">
                            <rect x={labelX} y={labelY - 12} width={labelWidth} height={24} rx={8} fill="#080c16" fillOpacity={0.97} stroke={accent} strokeOpacity={0.62} />
                            <rect x={labelX} y={labelY - 12} width={3} height={24} rx={1.5} fill={accent} />
                            <text x={labelX + 10} y={labelY + 3.5} fill="#edf3ff" fontFamily={monoFont} fontSize={10} fontWeight={700}>
                              {shortLabel}
                              <tspan dx="7" fill="#9aa9c2">{Number(node.data.pct || 0).toFixed(2)}%</tspan>
                            </text>
                          </g>
                        )}
                        <title>{displayName(node.id)} · {node.data.pct ?? 0}%</title>
                      </g>
                    );
                  })}
                  </g>
                </svg>
                <div className="bubblemap-map-meta">
                  <span>Solid: cluster evidence&nbsp; · &nbsp;dotted: weaker observed links</span>
                  <span>Block {Number(map.computed_at_block || 0).toLocaleString()} · holders every 6h · transfers incremental</span>
                </div>
              </section>

              <div className="bubblemap-sidebar">
                <section className="bubblemap-side-card">
                  <div className="bubblemap-section-heading">
                    <div className="bubblemap-section-title">Connected clusters</div>
                    <span className="bubblemap-count">{connectedClusters.length} linked</span>
                  </div>
                  <div className="bubblemap-clusters">
                    {orderedClusters.length ? orderedClusters.map((cluster) => (
                      <button
                        type="button"
                        key={cluster.id}
                        className="bubblemap-cluster-row"
                        aria-pressed={selectedCluster === cluster.id}
                        onClick={() => { setSelectedCluster(cluster.id); setSelectedAddress(null); }}
                      >
                        <span className="bubblemap-cluster-dot" style={{ background: cluster.strength === "strong" ? clusterColor(cluster.id) : "#66706b" }} />
                        <span>
                          <span className="bubblemap-cluster-name">{cluster.strength === "strong" ? `Cluster ${cluster.id}` : "Weak connection"} · {cluster.members} wallet{cluster.members === 1 ? "" : "s"}</span>
                          <span className="bubblemap-cluster-note">{cluster.strength === "strong" ? "Strong" : "Weak"} · {cluster.reasons_summary.map(reasonLabel).join(" · ")}</span>
                        </span>
                        <span className="bubblemap-cluster-share">{clusterSupplyPercent(map, cluster).toFixed(2)}%</span>
                      </button>
                    )) : <div className="bubblemap-empty">No linked holder clusters were detected in this snapshot.</div>}
                  </div>
                </section>

                <section className="bubblemap-side-card">
                  <div className="bubblemap-section-heading">
                    <div className="bubblemap-section-title">{chosenNode ? "Wallet detail" : chosenConnectedCluster ? (chosenConnectedCluster.strength === "strong" ? `Cluster ${chosenConnectedCluster.id}` : "Weak connection") : "Selection detail"}</div>
                    {chosenNode && <span className="bubblemap-count">HOLDER</span>}
                  </div>
                  <div className="bubblemap-selection">
                    {chosenNode && (
                      <>
                        <div className="bubblemap-selection-name">{displayName(chosenNode.address)}</div>
                        <div className="bubblemap-selection-address">{chosenNode.address}</div>
                        <div className="bubblemap-selection-balance">
                          {formatBalance(chosenNode.balance, tokenInfo?.decimals)} {tokenInfo?.symbol || ""} · {chosenNode.pct ?? "—"}% of supply
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                          {(chosenNode.tags || []).map((tag) => <span key={tag} style={tagStyle}>{tag}</span>)}
                          {chosenNode.excluded && <span style={tagStyle}>{chosenNode.exclusion_reason}</span>}
                        </div>
                        {chosenEdges.map((edge) => (
                          <div key={`${edge.a}-${edge.b}`} style={{ color: muted, fontSize: 10, marginTop: 4, lineHeight: 1.45 }}>
                            {edge.reasons.map((reason) => `${reasonLabel(reason.type)}: ${reason.detail}`).join(" · ")}
                          </div>
                        ))}
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10, fontSize: 10 }}>
                          <a href={`${EXPLORER_BASE_URL}/address/${chosenNode.address}`} target="_blank" rel="noreferrer" style={linkStyle}>Explorer <ExternalLink size={11} /></a>
                          <a href={`/pnl?wallet=${encodeURIComponent(chosenNode.address)}`} style={linkStyle}>PnL tools</a>
                        </div>
                      </>
                    )}
                    {chosenConnectedCluster && (
                      <>
                        <div style={{ color: mutedLight, fontSize: 10, lineHeight: 1.5, marginBottom: 7 }}>
                          {chosenConnectedCluster.strength === "strong" ? "Strong cluster" : "Weak connection"}: {chosenConnectedCluster.members} wallet{chosenConnectedCluster.members === 1 ? "" : "s"} hold {clusterSupplyPercent(map, chosenConnectedCluster).toFixed(2)}% of total supply. Reasons: {chosenConnectedCluster.reasons_summary.map(reasonLabel).join(", ")}.
                        </div>
                        {chosenClusterMembers.map((node) => (
                          <button
                            key={node.address}
                            type="button"
                            className="bubblemap-member-row"
                            onClick={() => { setSelectedAddress(node.address); setSelectedCluster(null); }}
                          >
                            {displayName(node.address)} <span>{node.pct ?? "—"}%</span>
                          </button>
                        ))}
                      </>
                    )}
                    {!chosenNode && !chosenConnectedCluster && (
                      <div className="bubblemap-empty">Select a bubble or a cluster to inspect holder balances and the observed connection signals.</div>
                    )}
                  </div>
                </section>
              </div>
            </div>

            {excludedNodes.length > 0 && (
              <details className="bubblemap-excluded">
                <summary>Excluded addresses ({excludedNodes.length})</summary>
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
            <div style={{ color: "#748287", fontSize: 9, lineHeight: 1.5 }}>
              Informational only, not financial advice. Same-funder evidence makes the edge solid.
              “Same first funder” means both wallets’ earliest observed inbound native transfer came from
              the same non-hub wallet; it is blockchain evidence, but not proof of common ownership.
            </div>
          </>
        )}
      </div>
    </DashboardPanel>
  );
}

function Metric({ label, value, note }) {
  return (
    <div className="bubblemap-stat">
      <div className="bubblemap-label">{label}</div>
      <div className="bubblemap-stat-value">{value}</div>
      <div className="bubblemap-stat-note">{note}</div>
    </div>
  );
}

function buttonStyle() {
  return { display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${border}`, borderRadius: 6, background: panel2, color: mutedLight, padding: "6px 9px", fontFamily: monoFont, fontSize: 10, fontWeight: 700, cursor: "pointer" };
}

const inputStyle = { background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 12, boxSizing: "border-box" };
const tagStyle = { border: `1px solid ${border}`, borderRadius: 10, padding: "2px 6px", color: muted, fontSize: 9 };
const linkStyle = { display: "inline-flex", alignItems: "center", gap: 3, color: green, textDecoration: "none", fontWeight: 700 };
