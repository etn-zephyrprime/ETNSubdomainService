import React, { useMemo } from "react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useNftSales } from "../hooks/useNftSales.js";
import { formatEtnBalance, formatChartDate, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import SparklineChart from "./SparklineChart.jsx";

const RECENT_SALES_SHOWN = 10;

// NFT collections aren't an ElectroSwap trading pair, so TokenPriceChart.jsx's GeckoTerminal-pool
// lookup always comes back empty for one — this replaces it on TokenDetail.jsx for NFT-type
// tokens with something that actually reflects this asset class: real on-chain sale history from
// Seaport's OrderFulfilled events (see nftSalesCache.js), not a price/market-cap line.
//
// Deliberately no "Floor Price" stat — see nftSalesCache.js's header comment for why that's not
// honestly derivable from on-chain data at all for Seaport (listings are off-chain signed orders;
// only fulfillment/cancellation ever touch the chain). "Last Sale" is shown instead: a real,
// verifiable number pulled straight from the most recent priced sale.
export default function NftSalesChart({ address }) {
  const { sales, loading, error } = useNftSales(address);

  const pricedSales = useMemo(() => (sales || []).filter((s) => s.priceWei != null), [sales]);
  const lastSale = pricedSales.length > 0 ? pricedSales[pricedSales.length - 1] : null;
  const series = useMemo(
    () => pricedSales.map((s) => ({ label: new Date(s.timestampMs).toISOString(), value: parseFloat(formatEtnBalance(s.priceWei).replace(/,/g, "")) })),
    [pricedSales]
  );
  const recentSales = (sales || []).slice(-RECENT_SALES_SHOWN).reverse();

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 14 }}>
        Sale History <span style={{ fontWeight: 500, textTransform: "none", color: mutedLight }}>· via Seaport, on-chain</span>
      </div>

      {loading ? (
        <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
          Loading…
        </div>
      ) : !sales || sales.length === 0 ? (
        <div style={{ fontSize: 12, color: muted, textAlign: "center", padding: "24px 0" }}>
          No sales recorded on-chain for this collection yet. (History is still backfilling — check back later.)
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Last Sale</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>
                {lastSale ? `${formatEtnBalance(lastSale.priceWei)} ETN` : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>When</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>
                {lastSale ? timeAgo(new Date(lastSale.timestampMs).toISOString()) : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Total Sales</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{sales.length}</div>
            </div>
          </div>

          {series.length >= 2 ? (
            <SparklineChart data={series} height={140} formatValue={(v) => `${v.toFixed(2)} ETN`} formatLabel={(l) => formatChartDate(l, true)} />
          ) : (
            <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: muted }}>
              Not enough priced sales yet for a trend line.
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 700, color: mutedLight, margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: 0.6 }}>
            Recent Sales
          </div>
          {recentSales.map((s) => (
            <a
              key={s.txHash + s.tokenId}
              href={`${EXPLORER_BASE_URL}/tx/${s.txHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
            >
              <div>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace" }}>#{s.tokenId}</div>
                <div style={{ fontSize: 10, color: mutedLight }}>{shortHash(s.seller)} → {shortHash(s.buyer)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: s.priceWei != null ? green : mutedLight }}>
                  {s.priceWei != null ? `${formatEtnBalance(s.priceWei)} ETN` : "other currency"}
                </div>
                <div style={{ fontSize: 10, color: mutedLight }}>{timeAgo(new Date(s.timestampMs).toISOString())}</div>
              </div>
            </a>
          ))}
        </>
      )}
    </div>
  );
}
