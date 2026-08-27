import React, { useMemo } from "react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useNameServiceStats } from "../hooks/useNameServiceStats.js";
import { bucketDailyCounts } from "../utils/history.js";
import { formatCompact, formatInt, formatChartDate, formatEtnBalance } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";

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

  const trendData = useMemo(() => {
    if (!stats?.events) return [];
    const relevant = stats.events
      .filter((e) => e.type === "domain_activated" || e.type === "subname_registered")
      .map((e) => ({ timestamp: new Date(e.timestampMs).toISOString() }));
    return bucketDailyCounts(relevant, "timestamp", TREND_WINDOW_DAYS);
  }, [stats]);

  const volume30dWei = useMemo(() => {
    if (!stats?.events) return null;
    const cutoff = Date.now() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const sales = stats.events.filter((e) => e.type === "listing_sold" && e.timestampMs >= cutoff);
    if (sales.length === 0) return { total: 0n, count: 0 };
    return { total: sales.reduce((sum, e) => sum + BigInt(e.priceWei), 0n), count: sales.length };
  }, [stats]);

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }
  if (loading) {
    return <div style={{ fontSize: 12, color: muted, textAlign: "center", padding: 24 }}>Loading…</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
        Activity on the ETN Subdomain Service itself — domain registrations, subname sales, and
        marketplace resales. Not available on any general block explorer.
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
          New domains + subnames per day, last {TREND_WINDOW_DAYS} days
        </div>
        <SparklineChart data={trendData} height={140} formatValue={formatInt} formatLabel={formatChartDate} />
      </div>

      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Marketplace Volume ({TREND_WINDOW_DAYS}D)
        </div>
        {volume30dWei && volume30dWei.count > 0 ? (
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>
              {formatEtnBalance(volume30dWei.total)} ETN
            </div>
            <div style={{ fontSize: 12, color: mutedLight, marginTop: 2 }}>
              {volume30dWei.count} name{volume30dWei.count === 1 ? "" : "s"} resold
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: muted }}>
            No resales in the last {TREND_WINDOW_DAYS} days — the marketplace is tracked live and
            ready to show volume the moment a name resells.
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
          <div
            key={d.node}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}
          >
            <span style={{ fontSize: 12, color: "#fff" }}>{d.label}.etn</span>
            <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
              {formatInt(d.subnames?.length || 0)} subname{(d.subnames?.length || 0) === 1 ? "" : "s"}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
