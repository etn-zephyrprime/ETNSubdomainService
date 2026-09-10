import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { LineChart, TrendingUp, Image as ImageIcon, Sparkles } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import { PnlValueToggle, PnlSubModeToggle, pnlOverTimeValue } from "./CoreTierPnl.jsx";
import PortfolioCompositionChart from "./PortfolioCompositionChart.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { useBlockscout } from "../../hooks/useBlockscout.js";
import { useEtnPriceHistory } from "../../hooks/useEtnPriceHistory.js";
import { useEtnPrice } from "../../../hooks/useEtnPrice.js";
import { useCoreTierDemo } from "../../hooks/useCoreTierDemo.js";
import { useTokenChart } from "../../hooks/useTokenChart.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { mergeBalanceHistories, buildEtnPriceLookup, convertSeriesToUsd, buildDailySeries } from "../../utils/balanceHistory.js";
import { getHistoricalBalance } from "../../utils/historicalBalance.js";
import { formatChartDate, formatUsdPrice, formatTokenAmount, isSpamTokenName } from "../../utils/format.js";
import { green, mutedLight, orange, muted, border, panel2, error as errorColor } from "../../theme.js";

// Three real, unrelated wallets with genuine on-chain activity — MUST stay in sync with
// coreTierDemoRouter.js's own copy of this same list (no shared build step between frontend/
// backend in this repo, same reasoning as several other hand-synced constants elsewhere). Only
// ever used here for the COUNT (3) and as the candidate list for Balance History's own direct
// Blockscout calls (see DemoBalanceHistory's own comment on why that one section stays
// client-side) — every OTHER section gets its data from coreTierDemoRouter.js's response, which
// never sends these addresses back, only a walletIndex. Labeled "Wallet A/B/C" everywhere in this
// file, never the real address — see WALLET_LABELS below.
const DEMO_WALLET_ADDRESSES = [
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099",
  "0xd6cf49cbcf84b2cd2472a376b5f791689a0769d0",
  "0xc92e01d795313ad4f93c6d35ce764ce3dad6d0ee",
];
const WALLET_LABELS = ["Wallet A", "Wallet B", "Wallet C"];
const WINDOW_DAYS = 365; // matches CoreTierBalanceHistory.jsx's own rolling-12-months convention
const MAX_PRICED_HOLDINGS = 50; // matches CoreTierPortfolio.jsx's own cap

// UI-only display scale — every USD/quantity/balance figure the demo shows is multiplied by this
// before rendering, so a viewer who happens to know one of the 3 real wallets' actual balance can't
// identify it by matching an exact number. Deliberately display-only: the backend (coreTierDemoRouter.js
// /generateDemoSnapshot.js) computes and persists the wallets' REAL figures, unscaled — this file is
// the only place the reduction is ever applied. Two separate application points, both driven by this
// same constant: scaleForDisplay() below (everything that comes from coreTierDemoRouter.js's
// response) and DemoBalanceHistory's own chart series (its data never goes through that response at
// all — see that component's own comment on why it fetches independently).
const DEMO_DISPLAY_SCALE = 0.8;
// BigInt-safe equivalent of ×DEMO_DISPLAY_SCALE, for rawBalance/totalCoinBalance below (wei values
// that can exceed float precision) — derived from the constant above (not a separately hand-kept
// fraction) so the two can never drift apart if DEMO_DISPLAY_SCALE ever changes.
const DISPLAY_SCALE_PRECISION = 1_000_000n;
const DISPLAY_SCALE_NUMERATOR = BigInt(Math.round(DEMO_DISPLAY_SCALE * Number(DISPLAY_SCALE_PRECISION)));

// Field names (anywhere in the fetched demo payload, at any nesting depth) that represent a USD
// amount, an on-chain token quantity, or a wei-scale raw balance — scaled by DEMO_DISPLAY_SCALE.
// Deliberately an ALLOWLIST, not a blocklist: an unrecognized future field defaults to "left alone"
// rather than risking a count/tokenId/fee-tier/percentage getting nonsensically scaled by default.
const SCALED_FIELDS = new Set([
  "currentValueUsd", "unrealizedPnlUsd", "realizedPnlUsd", "totalValueUsd", "totalMarketValueUsd",
  "totalUnrealizedUsd", "costBasisUsd", "marketValueUsd", "quantity", "rawBalance", "totalCoinBalance",
  "amount", "usdValue", "totalUsd", "totalCostBasisUsd", "heldCostBasisUsd", "soldCostBasisUsd",
  "proceedsUsd", "unitCostUsd", "gasUsd", "totalGasUsd",
]);

/** Recursively scales every SCALED_FIELDS value in `node` by DEMO_DISPLAY_SCALE, leaving every
 * other field (dates, symbols, addresses, counts, tokenId, fee tier, in-range flags, generatedAt,
 * ...) untouched. rawBalance/totalCoinBalance are wei -- always whole numbers on real chain data --
 * so BigInt math is used for those specifically to keep the scaled value a whole number too, rather
 * than truncating a decimal string; every other field is a human-unit Decimal string already,
 * where a fractional result is normal, so plain float multiplication (display-only, never fed back
 * into any calculation) is fine. */
function scaleForDisplay(node) {
  if (node == null) return node;
  if (Array.isArray(node)) return node.map(scaleForDisplay);
  if (typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!SCALED_FIELDS.has(key)) {
      out[key] = scaleForDisplay(value); // recurse regardless of key, so nested objects/arrays still get scanned
      continue;
    }
    if (typeof value === "number") {
      out[key] = value * DEMO_DISPLAY_SCALE;
    } else if (typeof value === "string" && /^-?\d+$/.test(value) && (key === "rawBalance" || key === "totalCoinBalance")) {
      out[key] = ((BigInt(value) * DISPLAY_SCALE_NUMERATOR) / DISPLAY_SCALE_PRECISION).toString();
    } else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = (Number(value) * DEMO_DISPLAY_SCALE).toString();
    } else {
      out[key] = value; // not actually numeric -- leave as-is rather than guess
    }
  }
  return out;
}
const CATEGORY_OPTIONS = [
  { key: "liquidity", label: "Liquidity Positions" },
  { key: "farm_staking", label: "Staking / Yield Farms" },
];

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
const selectStyle = { padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: "#fff", fontSize: 12, fontWeight: 600, outline: "none" };

/** ETN Balance History, combined across all three demo wallets — same Blockscout coin-balance-
 * history-by-day + historicalBalance.js backfill + /api/etn-price-history CoreTierBalanceHistory.jsx
 * itself uses for a real member's multiple tracked wallets, just fixed to the 3 demo addresses.
 * Deliberately still client-side/direct-to-Blockscout (unlike every other section here, now server-
 * computed) — this is the one exception carried over from this demo's very first version: every
 * one of THIS section's own data sources was already public/unauthenticated, so there's no real
 * PnL-style computation to protect behind a cache, and no different anonymity story: the real
 * addresses appear in the browser's network requests either way (same as they always have for
 * wallet A specifically), never in anything rendered on screen. */
function DemoBalanceHistory() {
  const { getAddressCoinBalanceHistory } = useBlockscout();
  const { getEtnPriceHistory } = useEtnPriceHistory();

  const [historiesByAddress, setHistoriesByAddress] = useState({});
  const [error, setError] = useState(null);
  const [historicalSeeds, setHistoricalSeeds] = useState({});
  const [pricePoints, setPricePoints] = useState(null);
  const [valueMode, setValueMode] = useState("etn");

  useEffect(() => {
    let cancelled = false;
    setHistoriesByAddress(Object.fromEntries(DEMO_WALLET_ADDRESSES.map((a) => [a, null])));
    Promise.all(
      DEMO_WALLET_ADDRESSES.map((addr) =>
        getAddressCoinBalanceHistory(addr)
          .then((res) => [addr, Array.isArray(res?.items) ? res.items : []])
          .catch((err) => {
            console.error("Demo: failed to load balance history:", err.message);
            return [addr, []];
          })
      )
    ).then((entries) => {
      if (!cancelled) setHistoriesByAddress(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [getAddressCoinBalanceHistory]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(DEMO_WALLET_ADDRESSES.map((addr) => getHistoricalBalance(addr, WINDOW_DAYS).then((v) => [addr, v ?? 0]))).then(
      (entries) => { if (!cancelled) setHistoricalSeeds(Object.fromEntries(entries)); }
    );
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
  const loaded = DEMO_WALLET_ADDRESSES.every((a) => historiesByAddress[a] != null);

  // Same "raw sparse items + wei seeds in, sparse combined ETN series out" pipeline
  // CoreTierBalanceHistory.jsx's own combinedSparse uses for a real member's multiple tracked
  // wallets — mergeBalanceHistories does the cross-wallet forward-fill+sum itself; it does NOT
  // take pre-densified per-wallet series (that's buildDailySeries' own, separate, single-series job,
  // applied AFTER merging, not before).
  function toWeiSeed(etnValue) {
    try {
      return ethers.parseEther((etnValue || 0).toFixed(18));
    } catch {
      return 0n;
    }
  }
  const combinedSparse = loaded
    ? mergeBalanceHistories(DEMO_WALLET_ADDRESSES.map((a) => historiesByAddress[a]), DEMO_WALLET_ADDRESSES.map((a) => toWeiSeed(historicalSeeds[a])))
    : [];
  const combinedSeedEtn = DEMO_WALLET_ADDRESSES.reduce((sum, a) => sum + (historicalSeeds[a] || 0), 0);
  const hasHistory = combinedSparse.length > 0 || combinedSeedEtn > 0;
  const seriesEtn = buildDailySeries(combinedSparse, WINDOW_DAYS, combinedSeedEtn);
  const rawSeries = showUsd ? convertSeriesToUsd(seriesEtn, priceLookup) : seriesEtn;
  // Scaled here rather than at the raw historiesByAddress/historicalSeeds level -- this section's
  // own data never goes through coreTierDemoRouter.js's response (see this component's own header
  // comment), so scaleForDisplay's field-name allowlist doesn't apply; scaling the final series
  // values covers both the ETN and USD toggle in one place, same DEMO_DISPLAY_SCALE as everywhere
  // else in this file.
  const series = rawSeries.map((p) => ({ ...p, value: p.value * DEMO_DISPLAY_SCALE }));
  const formatValue = showUsd ? formatUsdPrice : fmtEtn;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 10 }}>
        {loaded && (
          <div style={{ display: "flex", gap: 6 }}>
            {[{ id: "etn", label: "ETN" }, { id: "usd", label: "USD" }].map((m) => (
              <button
                key={m.id}
                onClick={() => setValueMode(m.id)}
                disabled={m.id === "usd" && !usdReady}
                style={{
                  padding: "5px 12px", borderRadius: 8,
                  border: `1px solid ${m.id === valueMode ? green : border}`,
                  background: m.id === valueMode ? "rgba(24,187,26,0.12)" : panel2,
                  color: m.id === "usd" && !usdReady ? muted : m.id === valueMode ? green : mutedLight,
                  fontSize: 11, fontWeight: 700, cursor: m.id === "usd" && !usdReady ? "not-allowed" : "pointer",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months, combined across 3 wallets</div>
      {error ? (
        <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
      ) : !loaded ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Loading…</div>
      ) : !hasHistory ? (
        <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
      ) : (
        <SparklineChart data={series} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
      )}
    </>
  );
}

/** Total Portfolio Balance, Portfolio Composition chart, Combined ETN Balance, Liquidity
 * Positions, Staked/Farming Positions, and Combined Holdings — the always-open section, matching
 * CoreTierPortfolio.jsx's own always-open panel exactly (same figures, same chart, same
 * section order), just built from `data` (coreTierDemoRouter.js's one response) instead of four
 * separate signed requests. */
function DemoPortfolio({ data, onSelectToken }) {
  const etnUsdPrice = useEtnPrice();
  const { getTokenChart } = useTokenChart();
  const { resolve: resolveTokenName, isSpam: isSpamToken } = useTokenNames((data.combinedHoldings.tokens || []).map((t) => t.tokenAddress));
  const [tokenPrices, setTokenPrices] = useState({});
  const [holdingsShown, setHoldingsShown] = useState(10);

  const fungibleTokens = (data.combinedHoldings.tokens || []).filter((t) => t.tokenAddress && !isSpamTokenName(t.name));

  useEffect(() => {
    let cancelled = false;
    fungibleTokens.slice(0, MAX_PRICED_HOLDINGS).forEach((t) => {
      const addr = t.tokenAddress.toLowerCase();
      getTokenChart(addr, "7")
        .then((res) => {
          if (cancelled || !res?.candles?.length) return;
          setTokenPrices((prev) => ({ ...prev, [addr]: res.candles[res.candles.length - 1].close }));
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.combinedHoldings.tokens]);

  const combinedEtnAmount = parseFloat(ethers.formatEther(BigInt(data.combinedHoldings.totalCoinBalance || 0)));
  const combinedEtnUsd = etnUsdPrice != null ? combinedEtnAmount * etnUsdPrice : null;

  const visibleTokens = fungibleTokens
    .map((t) => {
      const priceUsd = tokenPrices[t.tokenAddress.toLowerCase()];
      const amount = parseFloat(ethers.formatUnits(BigInt(t.rawBalance), t.decimals ?? 18));
      const usdValue = priceUsd != null && Number.isFinite(amount) ? amount * priceUsd : null;
      return { ...t, amount, usdValue };
    })
    .sort((a, b) => {
      if (a.usdValue == null && b.usdValue == null) return 0;
      if (a.usdValue == null) return 1;
      if (b.usdValue == null) return -1;
      return b.usdValue - a.usdValue;
    });
  const tokensUsdTotal = visibleTokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);

  const defiUsd = data.defiPositions.totalUsd != null ? Number(data.defiPositions.totalUsd) : null;
  const lpUsd = data.liquidityPositions.totalUsd != null ? Number(data.liquidityPositions.totalUsd) : null;
  const totalPortfolioUsd = (combinedEtnUsd ?? 0) + tokensUsdTotal + (defiUsd ?? 0) + (lpUsd ?? 0);
  const totalHasUnpriced =
    (etnUsdPrice == null && combinedEtnAmount > 0) ||
    visibleTokens.some((t) => t.usdValue == null && t.amount > 0) ||
    Boolean(data.defiPositions.hasUnpriced) ||
    Boolean(data.liquidityPositions.hasUnpriced);

  const compositionSlices = [
    { key: "native", label: "Native ETN", value: combinedEtnUsd ?? 0 },
    { key: "tokens", label: "Tokens", value: tokensUsdTotal },
    { key: "liquidity", label: "Liquidity Positions", value: lpUsd ?? 0 },
    { key: "staking", label: "Staking / Yield Farms", value: defiUsd ?? 0 },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Sparkles size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Core Tier — Portfolio (Demo)
        </div>
      </div>

      <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
        <div style={sectionHeaderStyle}>
          Total Portfolio Balance (USD)
          <InfoTooltip text="Everything this dashboard can price: native ETN, tokens, liquidity positions, and anything staked or farming — added together, across all 3 demo wallets." />
        </div>
        <div style={{ fontSize: 26, fontWeight: 900, color: "#fff" }}>
          {totalHasUnpriced ? "≈ " : ""}{formatUsdPrice(totalPortfolioUsd)}
        </div>
        <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>ETN + all priced holdings, across 3 tracked wallets</div>
      </div>

      <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
        <div style={sectionHeaderStyle}>
          Portfolio Composition
          <InfoTooltip text="How Total Portfolio Balance splits across the four kinds of value this dashboard tracks. Hover a wedge or a legend row to highlight it." />
        </div>
        <PortfolioCompositionChart slices={compositionSlices} hasUnpriced={totalHasUnpriced} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={sectionHeaderStyle}>
          Combined ETN Balance
          <InfoTooltip text="Native ETN sitting directly in the wallets — the chain's own coin, not a token contract." />
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{fmtEtn(combinedEtnAmount)}</div>
          {combinedEtnUsd != null && <div style={{ fontSize: 13, color: mutedLight, fontWeight: 600 }}>{formatUsdPrice(combinedEtnUsd)}</div>}
        </div>
        <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>Across 3 tracked wallets</div>
      </div>

      {data.defiPositions.positions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={sectionHeaderStyle}>
            Staked / Farming Positions
            <InfoTooltip text="Funds currently locked in a yield farm or staking contract — valued live from the contract's own state." />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.defiPositions.positions.map((p, i) => (
              <div key={`${p.contractAddress}-${p.farmId ?? "stake"}-${i}`} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{p.label}</span>
                  <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                    {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                  {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(data.liquidityPositions.v2Positions.length > 0 || data.liquidityPositions.v3Positions.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <div style={sectionHeaderStyle}>
            Liquidity Positions
            <InfoTooltip text="LP pool tokens and concentrated-liquidity (V3) positions held directly — valued live from each pool's own current reserves/price." />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.liquidityPositions.v2Positions.map((p) => (
              <div key={p.tokenAddress} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{(p.legs[0]?.symbol || "?")}/{(p.legs[1]?.symbol || "?")} LP</span>
                  <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                    {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                  {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                </div>
              </div>
            ))}
            {data.liquidityPositions.v3Positions.map((p) => (
              <div key={p.tokenId} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>
                    {(p.legs[0]?.symbol || "?")}/{(p.legs[1]?.symbol || "?")} V3 #{p.tokenId}
                    {!p.inRange && <span style={{ color: orange, fontWeight: 700 }}> · out of range</span>}
                  </span>
                  <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                    {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                  {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={sectionHeaderStyle}>
          Combined Holdings
          <InfoTooltip text="Regular token balances sitting directly in the wallets — the same thing a block explorer would show." />
        </div>
        {visibleTokens.length === 0 ? (
          <div style={{ fontSize: 12, color: muted }}>No token balances across these wallets.</div>
        ) : (
          <>
            {visibleTokens.slice(0, holdingsShown).map((t, i) => (
              <div key={`${t.tokenAddress}-${i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}>
                <span style={{ fontSize: 12, color: "#fff" }}>
                  {onSelectToken ? (
                    <button
                      type="button"
                      onClick={() => onSelectToken(t.tokenAddress)}
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                      onMouseEnter={(e) => { e.currentTarget.style.textDecorationColor = green; }}
                      onMouseLeave={(e) => { e.currentTarget.style.textDecorationColor = "transparent"; }}
                    >
                      {resolveTokenName(t.tokenAddress)}
                    </button>
                  ) : (
                    resolveTokenName(t.tokenAddress)
                  )}
                  {t.heldByCount > 1 && <span style={{ display: "block", fontSize: 10, color: muted }}>Held in {t.heldByCount} of 3 wallets</span>}
                </span>
                <span style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(BigInt(t.rawBalance), t.decimals ?? 18)}</span>
                  {t.usdValue != null && <span style={{ display: "block", fontSize: 11, color: mutedLight }}>{formatUsdPrice(t.usdValue)}</span>}
                </span>
              </div>
            ))}
            {visibleTokens.length > holdingsShown && (
              <button
                type="button"
                onClick={() => setHoldingsShown((n) => n + 10)}
                style={{ display: "block", width: "100%", marginTop: 10, padding: "8px 0", borderRadius: 8, border: `1px solid ${border}`, background: panel2, color: green, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Show more ({visibleTokens.length - holdingsShown} more)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Current Value/Unrealized/Realized, per-wallet breakdown, Current Holdings, Value Over Time
 * chart, and the Liquidity Positions / Staking & Yield Farms category chart+dropdown — same shape
 * CoreTierPnl.jsx renders for a real member, built from `data` instead of a signed request. */
function DemoPnl({ data, onSelectToken }) {
  const { resolve: resolveTokenName, isSpam: isSpamToken } = useTokenNames((data.snapshot.holdings || []).map((h) => h.tokenAddress));
  const [chartMode, setChartMode] = useState("pnl");
  const [pnlSubMode, setPnlSubMode] = useState("combined");
  const [categoryChartMode, setCategoryChartMode] = useState("pnl");
  const [categoryPnlSubMode, setCategoryPnlSubMode] = useState("combined");
  const [selectedCategory, setSelectedCategory] = useState(CATEGORY_OPTIONS[0].key);

  const snapshot = data.snapshot;
  const holdings = (snapshot.holdings || []).filter((h) => !isSpamToken(h.tokenAddress) && h.marketValueUsd != null);
  const history = data.history || [];
  const categoryHistory = data.categoryHistory?.[selectedCategory] || [];

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
        <div style={{ fontSize: 10, color: muted, marginBottom: 2 }}>3 wallets combined</div>
        {data.perWallet.map((w) => (
          <div key={w.walletIndex} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: mutedLight }}>{WALLET_LABELS[w.walletIndex]}</span>
            <span style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#fff", fontWeight: 700 }}>{formatUsdPrice(Number(w.currentValueUsd))}</span>
              <span style={{ color: pnlColor(Number(w.unrealizedPnlUsd) + Number(w.realizedPnlUsd)) }}>
                {fmtSigned(Number(w.unrealizedPnlUsd) + Number(w.realizedPnlUsd))}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 20 }}>
        <div>
          <div style={sectionHeaderStyle}>Current Value</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(snapshot.currentValueUsd))}</div>
        </div>
        <div>
          <div style={sectionHeaderStyle}>Unrealized P&amp;L</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor(Number(snapshot.unrealizedPnlUsd)) }}>{fmtSigned(Number(snapshot.unrealizedPnlUsd))}</div>
        </div>
        <div>
          <div style={sectionHeaderStyle}>Realized P&amp;L</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor(Number(snapshot.realizedPnlUsd)) }}>{fmtSigned(Number(snapshot.realizedPnlUsd))}</div>
        </div>
      </div>

      {holdings.length > 0 && (
        <div style={{ marginBottom: 20 }}>
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ ...sectionHeaderStyle, marginBottom: 0 }}>{chartMode === "pnl" ? "PnL Over Time" : "Value Over Time"}</div>
          <PnlValueToggle chartMode={chartMode} setChartMode={setChartMode} />
        </div>
        {chartMode === "pnl" && <PnlSubModeToggle pnlSubMode={pnlSubMode} setPnlSubMode={setPnlSubMode} />}
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>No history yet.</div>
        ) : (
          <SparklineChart
            data={history.map((p) => ({ label: p.date, value: chartMode === "pnl" ? pnlOverTimeValue(p, pnlSubMode) : Number(p.totalValueUsd) }))}
            height={120}
            formatValue={chartMode === "pnl" ? fmtSigned : formatUsdPrice}
            formatLabel={formatChartDate}
            colorBySign={chartMode === "pnl"}
          />
        )}
      </div>

      <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ ...sectionHeaderStyle, marginBottom: 0 }}>{categoryChartMode === "pnl" ? "PnL Over Time" : "Value Over Time"}</div>
          <PnlValueToggle chartMode={categoryChartMode} setChartMode={setCategoryChartMode} />
        </div>
        {categoryChartMode === "pnl" && <PnlSubModeToggle pnlSubMode={categoryPnlSubMode} setPnlSubMode={setCategoryPnlSubMode} />}
        <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)} style={{ ...selectStyle, marginBottom: 12, width: "100%" }}>
          {CATEGORY_OPTIONS.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
        </select>
        {categoryHistory.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            No {CATEGORY_OPTIONS.find((o) => o.key === selectedCategory)?.label.toLowerCase()} history for these wallets.
          </div>
        ) : (
          <SparklineChart
            data={categoryHistory.map((p) => ({ label: p.date, value: categoryChartMode === "pnl" ? pnlOverTimeValue(p, categoryPnlSubMode) : Number(p.totalValueUsd) }))}
            height={120}
            formatValue={categoryChartMode === "pnl" ? fmtSigned : formatUsdPrice}
            formatLabel={formatChartDate}
            colorBySign={categoryChartMode === "pnl"}
          />
        )}
      </div>
    </>
  );
}

/** NFT cost basis/proceeds/realized P&L — same top-level figures CoreTierNftPnl.jsx shows for a
 * real member (that component's own `figures` is a RENAME of these exact fields —
 * combined.totalCostBasisUsd -> costBasisUsd, combined.heldTokenCount -> heldCount — mirrored here
 * so this reads the same raw combineLiveNftPnlSnapshots shape data.nftPnl actually is). */
function DemoNftPnl({ data }) {
  const combined = data.nftPnl;
  if (!combined || Number(combined.totalCostBasisUsd || 0) === 0) {
    return <div style={{ fontSize: 12, color: muted }}>No NFT activity across these wallets.</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
      <div>
        <div style={sectionHeaderStyle}>Cost Basis</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(combined.totalCostBasisUsd))}</div>
      </div>
      <div>
        <div style={sectionHeaderStyle}>Proceeds</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(combined.proceedsUsd))}</div>
      </div>
      <div>
        <div style={sectionHeaderStyle}>Realized P&amp;L</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: pnlColor(Number(combined.realizedPnlUsd)) }}>{fmtSigned(Number(combined.realizedPnlUsd))}</div>
      </div>
      <div>
        <div style={sectionHeaderStyle}>Held / Sold</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>
          {combined.heldTokenCount} <span style={{ color: mutedLight, fontSize: 14 }}>/</span> {combined.soldTokenCount}
        </div>
      </div>
    </div>
  );
}

/** Core Tier's actual value proposition, previewed for three real wallets — available to anyone,
 * including a visitor with no wallet connected at all. See CoreTierPortfolio.jsx's own "View Demo"
 * toggle, which renders this in place of CoreTierGate's connect/subscribe messaging.
 *
 * Mirrors the real Portfolio page's own structure as closely as a fixed, read-only preview
 * reasonably can: Portfolio (composition chart, ETN balance, DeFi/Liquidity positions, Combined
 * Holdings) stays always open, same as the real page; Balance History/PnL/NFT PnL collapse behind
 * a + the same way CollapsibleCoreTierPanel already does for a real member. Deliberately does NOT
 * include Alerts, adding/removing tracked wallets, or Membership Purchase — those are WRITE actions
 * tied to a real, authenticated identity (a Telegram link, a subscription, a tracked-wallet list),
 * not data a demo can meaningfully or safely fake; a plain Subscribe note stands in for them. */
export default function CoreTierDemo({ onSelectToken }) {
  const { getDemoPnl } = useCoreTierDemo();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getDemoPnl()
      // scaleForDisplay applied here, once, right after fetching -- res is the wallets' REAL
      // figures (see coreTierDemoRouter.js/generateDemoSnapshot.js's own comments); everything
      // downstream (DemoPortfolio/DemoPnl/DemoNftPnl) renders `data` exactly as before, already scaled.
      .then((res) => { if (!cancelled) setData(scaleForDisplay(res)); })
      .catch((err) => {
        console.error("Demo: failed to load:", err.message);
        if (!cancelled) setError("Couldn't load the demo right now.");
      });
    return () => { cancelled = true; };
  }, [getDemoPnl]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {error ? (
        <DashboardPanel><div style={{ fontSize: 12, color: errorColor }}>{error}</div></DashboardPanel>
      ) : !data ? (
        <DashboardPanel><div style={{ fontSize: 12, color: mutedLight }}>Loading demo…</div></DashboardPanel>
      ) : (
        <>
          <DashboardPanel>
            <DemoPortfolio data={data} onSelectToken={onSelectToken} />
          </DashboardPanel>

          <CollapsibleCoreTierPanel icon={LineChart} title="Core Tier — Balance History (Demo)">
            <DemoBalanceHistory />
          </CollapsibleCoreTierPanel>

          <CollapsibleCoreTierPanel icon={TrendingUp} title="Core Tier — PnL (Demo)">
            <DemoPnl data={data} onSelectToken={onSelectToken} />
          </CollapsibleCoreTierPanel>

          <CollapsibleCoreTierPanel icon={ImageIcon} title="Core Tier — NFT PnL (Demo)">
            <DemoNftPnl data={data} />
          </CollapsibleCoreTierPanel>

          <DashboardPanel>
            <div style={{ fontSize: 12, color: mutedLight, textAlign: "center", lineHeight: 1.6 }}>
              Alerts, adding your own wallets, and this data updating for real all come with a Core Tier membership.
              {data.generatedAt ? (
                <>
                  <br />
                  Demo snapshot from {new Date(data.generatedAt).toLocaleDateString()} — a real member's own data stays current.
                </>
              ) : null}
            </div>
          </DashboardPanel>
        </>
      )}
    </div>
  );
}
