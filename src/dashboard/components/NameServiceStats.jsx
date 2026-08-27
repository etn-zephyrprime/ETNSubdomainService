import React, { useMemo } from "react";
import { green, blue, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useNameServiceStats } from "../hooks/useNameServiceStats.js";
import { bucketDailyCounts } from "../utils/history.js";
import { formatCompact, formatInt, formatChartDate, formatEtnBalance, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL, SITE_URL } from "../config.js";
import SparklineChart from "./SparklineChart.jsx";
import ActivityComboChart from "./ActivityComboChart.jsx";

const TREND_WINDOW_DAYS = 30;

function StatCard({ label, value, sub }) {
  return (
    <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
      <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: mutedLight, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Proprietary .etn Name Service activity — Blockscout's own /stats page (and every generic chain
// explorer) has no way to show any of this: it sees raw addresses and transactions, not this
// app's naming layer on top. Domain/subname counts and the top-domains list come from
// activated-domains.json (already published for the homepage's own table — no new backend work);
// the registrations trend and marketplace volume/floor price come from the new
// nameServiceStatsCache.js, since neither timestamped event history nor sale prices existed
// anywhere in this backend before.
//
// Two genuinely different scopes shown here, deliberately kept visually separate rather than
// blended into one number: "All of Electroneum" (network_domain_registered events, sourced from
// BaseRegistrarImplementation — the chain-level registrar every .etn domain mints through
// regardless of which app was used) vs. "via ETN Subdomain Service" (this app's own Marketplace
// contract activity — domains that also activated subname-selling here, subnames sold through
// this app, marketplace resales). Confirmed live these are meaningfully different populations:
// 90 real network-wide registrations vs. only 4 domains this app's own Marketplace ever touched —
// blending them would misattribute the other 86 as if they were this app's own traffic.
export default function NameServiceStats() {
  const { domains, stats, loading, error } = useNameServiceStats();

  const sortedDomains = useMemo(
    () => (domains ? [...domains].sort((a, b) => (b.subnames?.length || 0) - (a.subnames?.length || 0)) : []),
    [domains]
  );
  const subnamesRegistered = useMemo(
    () => (domains ? domains.reduce((sum, d) => sum + (d.subnames?.length || 0), 0) : 0),
    [domains]
  );

  const totalNetworkDomains = useMemo(
    () => (stats?.events ? stats.events.filter((e) => e.type === "network_domain_registered").length : 0),
    [stats]
  );

  const networkTrendData = useMemo(() => {
    if (!stats?.events) return [];
    const relevant = stats.events
      .filter((e) => e.type === "network_domain_registered")
      .map((e) => ({ timestamp: new Date(e.timestampMs).toISOString() }));
    return bucketDailyCounts(relevant, "timestamp", TREND_WINDOW_DAYS);
  }, [stats]);

  // Split into two series rather than one blended count — a domain activating subname-selling
  // and a subname actually getting registered are different-enough events that folding them into
  // a single number obscured which one was actually driving a given day's activity. Rendered as
  // bars (activations) + an overlaid line (registrations), not stacked — stacking would imply
  // the two sum to a meaningful total, which they don't. bucketDailyCounts always zero-fills to
  // exactly TREND_WINDOW_DAYS entries regardless of input, so both arrays are guaranteed the same
  // length/day-order to zip by index.
  const trendData = useMemo(() => {
    if (!stats?.events) return [];
    const toIso = (type) =>
      stats.events.filter((e) => e.type === type).map((e) => ({ timestamp: new Date(e.timestampMs).toISOString() }));
    const activations = bucketDailyCounts(toIso("domain_activated"), "timestamp", TREND_WINDOW_DAYS);
    const registrations = bucketDailyCounts(toIso("subname_registered"), "timestamp", TREND_WINDOW_DAYS);
    return activations.map((d, i) => ({ label: d.label, a: d.value, b: registrations[i]?.value || 0 }));
  }, [stats]);

  const recentSales = useMemo(() => {
    if (!stats?.events) return [];
    const cutoff = Date.now() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return stats.events
      .filter((e) => e.type === "listing_sold" && e.timestampMs >= cutoff)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [stats]);

  const volume30dWei = useMemo(() => {
    if (recentSales.length === 0) return { total: 0n, count: 0 };
    return { total: recentSales.reduce((sum, e) => sum + BigInt(e.priceWei), 0n), count: recentSales.length };
  }, [recentSales]);

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }
  if (loading) {
    return <div style={{ fontSize: 12, color: muted, textAlign: "center", padding: 24 }}>Loading…</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
        The .etn naming layer — a general block explorer has no concept of it at all. Split below
        into every domain registered anywhere on Electroneum, and this service's own activity
        specifically.
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
        All of Electroneum
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 12 }}>
        <StatCard
          label="Total .etn Domains"
          value={formatCompact(totalNetworkDomains)}
          sub="Registered on-chain, any app"
        />
      </div>
      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8 }}>
          Domain registrations per day, last {TREND_WINDOW_DAYS} days
        </div>
        <SparklineChart data={networkTrendData} height={140} formatValue={formatInt} formatLabel={formatChartDate} />
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
        Via ETN Subdomain Service
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
        <StatCard label="Domains Activated" value={formatCompact(domains.length)} />
        <StatCard label="Subnames Registered" value={formatCompact(subnamesRegistered)} />
        <StatCard label="Active Listings" value={formatInt(stats?.activeListingsCount || 0)} />
        <StatCard
          label="Floor Price"
          value={stats?.floorPriceWei ? `${formatEtnBalance(stats.floorPriceWei)} ETN` : "—"}
          sub={!stats?.floorPriceWei ? "No active listings" : undefined}
        />
      </div>

      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8 }}>
          Per day, last {TREND_WINDOW_DAYS} days
        </div>
        <ActivityComboChart
          data={trendData}
          height={140}
          formatLabel={formatChartDate}
          seriesALabel="Domain Activations"
          seriesBLabel="Subname Registrations"
          colorA={green}
          colorB={blue}
        />
      </div>

      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Marketplace Volume ({TREND_WINDOW_DAYS}D)
        </div>
        {volume30dWei.count > 0 ? (
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#fff", marginBottom: 12 }}>
              {formatEtnBalance(volume30dWei.total)} ETN
              <span style={{ fontSize: 12, color: mutedLight, fontWeight: 400, marginLeft: 6 }}>
                ({volume30dWei.count} name{volume30dWei.count === 1 ? "" : "s"} resold)
              </span>
            </div>
            {recentSales.map((sale) => (
              <a
                key={sale.txHash}
                href={`${EXPLORER_BASE_URL}/tx/${sale.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${border}`, textDecoration: "none" }}
              >
                <span style={{ fontSize: 12, color: mutedLight }}>{timeAgo(new Date(sale.timestampMs).toISOString())}</span>
                <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                  {formatEtnBalance(sale.priceWei)} ETN <span style={{ color: mutedLight, fontWeight: 400 }}>↗</span>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: muted }}>
            No resales in the last {TREND_WINDOW_DAYS} days — the marketplace is tracked live and
            ready to show volume (linked to the block explorer) the moment a name resells.
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
        Top Domains by Subnames
      </div>
      {sortedDomains.length === 0 ? (
        <div style={{ fontSize: 12, color: muted }}>No activated domains yet.</div>
      ) : (
        sortedDomains.slice(0, 10).map((d) => (
          <a
            key={d.node}
            href={`${SITE_URL}/subnames/${d.label}.etn`}
            target="_blank"
            rel="noreferrer"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
          >
            <span style={{ fontSize: 12, color: "#fff" }}>{d.label}.etn</span>
            <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
              {formatInt(d.subnames?.length || 0)} subname{(d.subnames?.length || 0) === 1 ? "" : "s"}
            </span>
          </a>
        ))
      )}
    </div>
  );
}
