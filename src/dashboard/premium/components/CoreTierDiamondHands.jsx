import React, { useCallback, useEffect, useState } from "react";
import { Gem, ChevronDown, ChevronUp } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useDiamondHandsScore } from "../../hooks/useDiamondHandsScore.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { green, blue, orange, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };
const selectStyle = { padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: "#fff", fontSize: 12, fontWeight: 600, outline: "none" };

// Same weights/thresholds/cutoffs as backend/services/diamondHandsService.js -- kept here purely
// for display/methodology text, never used to compute anything (the backend is the only source of
// truth for the actual score). Provisional -- see that file's own header comment.
const TIER_COLORS = {
  "Titanium Hands": "#c6d6e8", // pale silver-blue, deliberately the coolest/rarest-looking of the four
  "Diamond Hands": "#5fd0ff",
  "Steady Hands": green,
  "Paper Hands": mutedLight,
};

// One image per outcome, served from /public/diamond-hands/ (see that folder's README.md for the
// exact filenames/specs). `null` tier ("Not enough data") uses no-data.png. Every image is optional:
// a missing file just falls back to the plain gem icon, so the panel never shows a broken image.
const TIER_IMAGES = {
  "Titanium Hands": "/diamond-hands/titanium-hands.png",
  "Diamond Hands": "/diamond-hands/diamond-hands.png",
  "Steady Hands": "/diamond-hands/steady-hands.png",
  "Paper Hands": "/diamond-hands/paper-hands.png",
};
const NO_DATA_IMAGE = "/diamond-hands/no-data.png";

// Small helper since every color this component tints (TIER_COLORS, and green/blue/orange from
// theme.js) is a plain 6-digit hex string, not one of theme.js's own separately-defined rgba
// Glow constants (those only exist for green/orange/blue/gold/silver/error, not the tier palette
// above) -- this covers all of them from one place instead of hand-writing an rgba() per color.
function withAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function tabButtonStyle(active) {
  return {
    padding: "6px 14px",
    borderRadius: 8,
    border: `1px solid ${active ? green : border}`,
    background: active ? withAlpha(green, 0.12) : panel2,
    color: active ? green : mutedLight,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  };
}

function fmtDays(days) {
  if (days == null) return "—";
  if (days < 1) return "<1 day";
  if (days < 60) return `${Math.round(days)} days`;
  return `${(days / 30).toFixed(1)} months`;
}
function fmtPct(rate) {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
function fmtScore(score) {
  return score == null ? "—" : Math.round(score).toString();
}

// The outcome's artwork on a soft radial glow in the tier's own color, so it reads as the "hero" of
// the card. Keyed by src so a tier change (e.g. switching wallet/asset) remounts and retries rather
// than inheriting a previous image's failed-to-load state.
function TierImage({ tier, tierColor, size = 132 }) {
  const src = tier ? TIER_IMAGES[tier] : NO_DATA_IMAGE;
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src || failedSrc === src) return <Gem size={size * 0.4} color={tierColor} style={{ flexShrink: 0, opacity: 0.8 }} />;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `radial-gradient(circle at 50% 55%, ${withAlpha(tierColor, 0.28)} 0%, ${withAlpha(tierColor, 0.08)} 55%, transparent 72%)`,
      }}
    >
      <img
        key={src}
        src={src}
        alt={tier || "Not enough data"}
        width={size}
        height={size}
        onError={() => setFailedSrc(src)}
        style={{ width: "100%", height: "100%", objectFit: "contain", filter: `drop-shadow(0 4px 14px ${withAlpha(tierColor, 0.45)})` }}
      />
    </div>
  );
}

// Circular 0-100 progress ring for the combined score -- the one number this feature is actually
// named for gets the most visual weight, with the 3 components underneath as secondary detail
// (see ComponentBar below), rather than every number competing at the same size.
function ScoreGauge({ score, tierColor, size = 92 }) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const offset = circumference * (1 - pct);

  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={border} strokeWidth={strokeWidth} />
      {score != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tierColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      )}
      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.3} fontWeight={900} fill={score == null ? mutedLight : "#fff"}>
        {fmtScore(score)}
      </text>
      <text x="50%" y="68%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.1} fill={muted} style={{ textTransform: "uppercase", letterSpacing: 1 }}>
        / 100
      </text>
    </svg>
  );
}

// One component's normalized 0-100 sub-score as a labeled horizontal bar -- `value` comes straight
// from the backend's own subScores (diamondHandsService.js's scoreFromComponents), never
// recomputed here, so a bar can never silently drift from the number that actually fed the combined
// score. An excluded/unknown component (null) renders as an empty, uncolored track rather than a
// misleading 0% (0% would read as "the worst possible", not "not enough data yet").
function ComponentBar({ label, value, color }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: mutedLight, fontWeight: 600 }}>{label}</span>
        <span style={{ color: value == null ? muted : "#fff", fontWeight: 700 }}>{value == null ? "—" : Math.round(value)}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            background: value == null ? border : color,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
}

/** The gauge + 3 component bars + raw figures behind a score — same shape shown at every
 * drill-down level (portfolio, wallet, asset) per the build brief's own "never just the score in
 * isolation" requirement. */
function ScoreCard({ label, result }) {
  if (!result) return null;
  const { components, score, tier, subScores } = result;
  const tierColor = tier ? TIER_COLORS[tier] : mutedLight;

  return (
    <div
      style={{
        padding: 18,
        borderRadius: 14,
        background: panel2,
        border: `1px solid ${tier ? withAlpha(tierColor, 0.5) : border}`,
        boxShadow: tier ? `0 0 24px ${withAlpha(tierColor, 0.12)}` : "none",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 16 }}>
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", justifyContent: "center" }}>
        <TierImage tier={tier} tierColor={tierColor} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <ScoreGauge score={score} tierColor={tierColor} />
          <div
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: withAlpha(tierColor, 0.15),
              border: `1px solid ${tierColor}`,
              fontSize: 11,
              fontWeight: 800,
              color: tierColor,
              whiteSpace: "nowrap",
            }}
          >
            {tier || "Not enough data"}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 190, display: "flex", flexDirection: "column", gap: 13 }}>
          <ComponentBar label="Panic-Sell Avoidance" value={subScores?.panicSell} color={green} />
          <ComponentBar label="Holding Period" value={subScores?.holdingPeriod} color={blue} />
          <ComponentBar label="Retention Rate" value={subScores?.retention} color={orange} />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 10,
          marginTop: 18,
          paddingTop: 14,
          borderTop: `1px solid ${border}`,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Avg. Holding Period</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{fmtDays(components.avgHoldingDays)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Retention Rate</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{fmtPct(components.retentionRate)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Panic-Sells</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
            {components.totalSells === 0 ? "Never sold" : `${fmtPct(components.panicSellRate)} of sells`}
          </div>
        </div>
      </div>
    </div>
  );
}

function Methodology() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${border}`, paddingTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", color: mutedLight, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        Understanding This Score
      </button>
      {open && (
        <div style={{ marginTop: 12, fontSize: 12, color: mutedLight, lineHeight: 1.7 }}>
          <p style={{ margin: "0 0 10px" }}>
            This score measures holding <em>behavior</em> — not performance. It says nothing about
            whether your trades made or lost money; a wallet that sat through a 90% drawdown without
            selling scores the same as one that sat through a 10x, given identical behavior.
            On-chain activity only (no exchange transfers), recalculated live — this is not a formal
            record and updates continuously as new activity comes in.
          </p>
          <p style={{ margin: "0 0 6px", fontWeight: 700, color: "#fff" }}>Three components, combined:</p>
          <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            <li style={{ marginBottom: 6 }}>
              <strong>Panic-sell avoidance (40% of score).</strong> For every sale, we check the price
              at that moment against the highest price in the preceding 30 days. Selling more than 15%
              below that recent high counts as a panic-sell. Fewer panic-sells → higher score. Never
              sold anything at all scores a perfect 100 here.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>Value-weighted holding period (35%).</strong> How long you've held each position,
              weighted by its dollar value when you acquired it — a year of average holding time scores
              a perfect 100 on this component.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>Retention rate (25%).</strong> Of the total dollar value you've ever acquired,
              how much (measured at ITS OWN acquisition cost, never today's price) do you still hold.
              Measuring at acquisition cost rather than current value keeps this a pure "did you keep
              it" measure — a token that went up in price doesn't inflate this on its own.
            </li>
          </ul>
          <p style={{ margin: "0 0 10px" }}>
            Tiers: <strong style={{ color: TIER_COLORS["Paper Hands"] }}>Paper Hands</strong> (0–39) →{" "}
            <strong style={{ color: TIER_COLORS["Steady Hands"] }}>Steady Hands</strong> (40–59) →{" "}
            <strong style={{ color: TIER_COLORS["Diamond Hands"] }}>Diamond Hands</strong> (60–79) →{" "}
            <strong style={{ color: TIER_COLORS["Titanium Hands"] }}>Titanium Hands</strong> (80–100).
          </p>
          <p style={{ margin: "0 0 10px" }}>
            NFTs are scored per collection, not per tokenId — every item you've ever held or sold
            from one collection is pooled into that collection's own row under "By Asset."
          </p>
          <p style={{ margin: 0, fontSize: 11, color: muted }}>
            The exact weights, the panic-sell threshold/window, and the tier cutoffs above are
            provisional starting points, chosen before real usage data existed to calibrate against —
            expect these to be refined over time as more of the platform's actual wallets are scored.
            A sale is only classified as a panic-sell (or not) when there's enough recent price history
            to judge it confidently; a sale that can't be classified either way is excluded from this
            component entirely, never guessed.
          </p>
        </div>
      )}
    </div>
  );
}

/** Everything below the notices: the score card for the current scope, the By Asset drill-down, and
 * the methodology. Purely presentational (takes an already-fetched result), so the real panel above
 * and CoreTierDemo.jsx's static snapshot render identically. `perAsset` is always the pooled
 * portfolio-wide list, regardless of which single wallet `scopeResult` is scoped to. */
export function DiamondHandsBody({ scopeResult, perAsset, isPortfolio }) {
  // Split by the backend's own classification (diamondHandsService.js's classifyAssetKey) rather
  // than re-detecting NFTs here from key shape -- native ETN, fungible tokens, and V3 liquidity
  // positions all read as "Tokens" (none of them are collectibles), only type "nft" (a grouped
  // collection, never a raw tokenId) reads as "NFTs".
  const tokenAssets = perAsset.filter((a) => a.type !== "nft");
  const nftAssets = perAsset.filter((a) => a.type === "nft");
  const hasBothKinds = tokenAssets.length > 0 && nftAssets.length > 0;

  const [assetTab, setAssetTab] = useState("tokens");
  // A wallet with only one kind of asset never shows the tab toggle at all (see below) -- this
  // makes sure the list actually shown always matches the kind that exists, regardless of which
  // tab happens to be selected in state, rather than silently rendering empty.
  const effectiveAssetTab = hasBothKinds ? assetTab : nftAssets.length > 0 ? "nfts" : "tokens";
  const activeAssetList = effectiveAssetTab === "nfts" ? nftAssets : tokenAssets;

  const { resolve: resolveTokenName } = useTokenNames(activeAssetList.map((a) => a.tokenAddress));

  // Asset filter -- local to this panel, same "self-heals to none if it falls out of scope"
  // reasoning as CoreTierNftPnl.jsx's own collection filter (a wallet-filter change, a tab switch,
  // or a refresh with different results shouldn't leave this pointed at an asset no longer in scope).
  const [assetFilterRaw, setAssetFilter] = useState("");
  const assetFilter = activeAssetList.some((a) => a.tokenAddress === assetFilterRaw) ? assetFilterRaw : "";
  const scopeAsset = assetFilter ? activeAssetList.find((a) => a.tokenAddress === assetFilter) : null;

  return (
    <>
      {scopeResult && (
        <>
            <ScoreCard label={isPortfolio ? "Portfolio" : "This Wallet"} result={scopeResult} />

            {perAsset.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ ...sectionHeaderStyle, display: "flex", alignItems: "center", gap: 6 }}>
                  By Asset
                  <InfoTooltip text="Drill into one token, NFT collection, or native ETN to see its own holding-period, retention, and panic-sell numbers, rather than the portfolio-wide blend above." />
                </div>

                {hasBothKinds && (
                  <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                    <button type="button" onClick={() => setAssetTab("tokens")} style={tabButtonStyle(effectiveAssetTab === "tokens")}>
                      Tokens ({tokenAssets.length})
                    </button>
                    <button type="button" onClick={() => setAssetTab("nfts")} style={tabButtonStyle(effectiveAssetTab === "nfts")}>
                      NFTs ({nftAssets.length})
                    </button>
                  </div>
                )}

                <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} style={{ ...selectStyle, width: "100%", marginBottom: 12 }}>
                  <option value="">All {effectiveAssetTab === "nfts" ? "NFTs" : "Tokens"} (combined, above)</option>
                  {activeAssetList.map((a) => (
                    <option key={a.tokenAddress} value={a.tokenAddress}>
                      {resolveTokenName(a.tokenAddress)} — {a.tier || "Not enough data"} ({fmtScore(a.score)})
                    </option>
                  ))}
                </select>
                {scopeAsset && <ScoreCard label={resolveTokenName(scopeAsset.tokenAddress)} result={scopeAsset} />}
              </div>
            )}
        </>
      )}

      <Methodology />
    </>
  );
}

// Core tier's Diamond Hands Score — a gamified holding-BEHAVIOR score (not a PnL figure) at three
// drill-down levels: portfolio (combined across covered wallets), per-wallet, and per-asset. Built
// entirely from the exact same FIFO ledger the live PnL snapshot and PnL Statement already use
// (see backend/services/diamondHandsService.js's own header comment) -- this can never disagree
// with those about what was actually held/disposed, only adds a different lens on top of it.
export default function CoreTierDiamondHands({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getDiamondHandsScore } = useDiamondHandsScore();

  const [result, setResult] = useState(null); // { asOf, portfolio, perWallet, perAsset, failed } | null
  const [resultError, setResultError] = useState(null);
  const [resultLoading, setResultLoading] = useState(false);

  const loadResult = useCallback(async () => {
    setResultLoading(true);
    setResultError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getDiamondHandsScore(wallet.account, signature, timestamp);
      setResult(res);
    } catch (err) {
      setResultError(err.message || "Couldn't compute your Diamond Hands score");
    } finally {
      setResultLoading(false);
    }
  }, [getAuthParams, getDiamondHandsScore, wallet.account]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setResult(null);
      return;
    }
    loadResult();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  // Same "walletFilter picks between combined and one wallet's own entry" convention as
  // CoreTierPnl.jsx/CoreTierNftPnl.jsx's own walletFilter handling.
  const scopeResult = walletFilter === "all" ? result?.portfolio : result?.perWallet?.find((w) => w.walletAddress === walletFilter);
  const filteredWalletFailed = walletFilter !== "all" && (result?.failed || []).includes(walletFilter);

  return (
    <CollapsibleCoreTierPanel icon={Gem} title="Diamond Hands Score">
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see your Diamond Hands Score"
      >
        {resultLoading && !result && (
          <div style={{ fontSize: 12, color: mutedLight, textAlign: "center", padding: "16px 0" }}>Computing your score…</div>
        )}
        {resultError && (
          <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{resultError}</div>
        )}

        {filteredWalletFailed && (
          <div style={{ fontSize: 12, color: orange, marginBottom: 12 }}>
            Couldn't compute a score for this specific wallet right now — try again shortly, or switch to "All Wallets".
          </div>
        )}

        <DiamondHandsBody scopeResult={scopeResult} perAsset={result?.perAsset || []} isPortfolio={walletFilter === "all"} />
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
