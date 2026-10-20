import React, { useCallback, useEffect, useRef, useState } from "react";
import { Gem } from "lucide-react";
import { useDiamondHandsScore } from "../../hooks/useDiamondHandsScore.js";
import { green, blue, orange, muted, mutedLight, error as errorColor, border, panel, panel2, monoFont } from "../../theme.js";
import CornerBrackets from "../../components/CornerBrackets.jsx";

const AUTH_PURPOSE = "Premium Dashboard";

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

// The outcome's artwork, shown as a rounded tile with a border and glow in the tier's own color so
// it reads as the "hero" of the card. The artwork is full-bleed square tiles (each with its own
// background and the tier name/score range baked in), not transparent cut-outs — hence a real tile
// treatment rather than a glow behind a floating subject, and a size big enough that the baked-in
// text stays legible. Purely presentational: ScoreCard owns whether it loaded (see there).
function TierImage({ src, tier, tierColor, onError, size = 176 }) {
  return (
    <img
      key={src}
      src={src}
      alt={tier || "Not enough data"}
      width={size}
      height={size}
      onError={onError}
      style={{
        width: size,
        height: size,
        maxWidth: "100%",
        flexShrink: 0,
        objectFit: "cover",
        borderRadius: 16,
        border: `1px solid ${withAlpha(tierColor, 0.55)}`,
        boxShadow: `0 0 26px ${withAlpha(tierColor, 0.28)}`,
      }}
    />
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
      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.3} fontWeight={900} fill={score == null ? mutedLight : "#fff"} style={{ fontFamily: monoFont }}>
        {fmtScore(score)}
      </text>
      <text x="50%" y="68%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.1} fill={muted} style={{ fontFamily: monoFont, textTransform: "uppercase", letterSpacing: 1 }}>
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

function ScoreCardBody({ label, result }) {
  const { components, score, tier, subScores } = result;
  const tierColor = tier ? TIER_COLORS[tier] : mutedLight;
  // Keyed by src, not a bare boolean, so switching to a different tier/asset retries rather than
  // inheriting a previous image's failed-to-load state. With the image showing, it already carries
  // the tier's name and score range, so the text pill below is dropped as a duplicate; if there's no
  // image (none for this outcome, or it failed to load) the gem icon + pill take over.
  const imageSrc = tier ? TIER_IMAGES[tier] : NO_DATA_IMAGE;
  const [failedSrc, setFailedSrc] = useState(null);
  const showImage = Boolean(imageSrc) && failedSrc !== imageSrc;

  return (
    <div
      style={{
        position: "relative",
        padding: 18,
        borderRadius: 6,
        background: panel2,
        border: `1px solid ${tier ? withAlpha(tierColor, 0.5) : border}`,
        boxShadow: tier ? `0 0 24px ${withAlpha(tierColor, 0.12)}` : "none",
      }}
    >
      <CornerBrackets color={tier ? tierColor : border} size={14} />
      <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 16 }}>
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", justifyContent: "center" }}>
        {showImage && <TierImage src={imageSrc} tier={tier} tierColor={tierColor} onError={() => setFailedSrc(imageSrc)} />}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <ScoreGauge score={score} tierColor={tierColor} />
          {!showImage && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
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
              <Gem size={12} color={tierColor} />
              {tier || "Not enough data"}
            </div>
          )}
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
          <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Avg. Holding Period</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{fmtDays(components.avgHoldingDays)}</div>
        </div>
        <div>
          <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Retention Rate</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{fmtPct(components.retentionRate)}</div>
        </div>
        <div>
          <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Panic-Sells</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
            {components.totalSells === 0 ? "Never sold" : `${fmtPct(components.panicSellRate)} of sells`}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The methodology text, always expanded — shown inside DiamondHandsCard's popover. */
function MethodologyText() {
  return (
    <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.7 }}>
      <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#fff", marginBottom: 8 }}>
        Understanding This Score
      </div>
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
        from one collection is pooled into that collection's own score.
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
  );
}

/** Compact Diamond Hands card for the top of the Core Tier page (it replaced the old Diamond Hands
 * tab): the tier artwork and name. Hover — or tap, on touch — opens a popover with the full score
 * card and the methodology. Same hover/tap/click-outside behavior as InfoTooltip.jsx. Purely
 * presentational, so the real page and CoreTierDemo.jsx's static snapshot render identically.
 * `result` is one scope's score (portfolio or one wallet's entry); null while loading. */
export function DiamondHandsCard({ result, label, loading = false, error = null }) {
  const [open, setOpen] = useState(false);
  const [failedSrc, setFailedSrc] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const tier = result?.tier || null;
  const tierColor = tier ? TIER_COLORS[tier] : mutedLight;
  const imageSrc = result ? (tier ? TIER_IMAGES[tier] : NO_DATA_IMAGE) : null;
  const showImage = Boolean(imageSrc) && failedSrc !== imageSrc;
  const statusText = error ? "Couldn't load" : loading && !result ? "Computing…" : result ? tier || "Not enough data" : "—";

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", flex: "1 1 220px", minWidth: 0 }}
      onMouseEnter={() => result && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => result && setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Diamond Hands Score details"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          height: "100%",
          padding: "10px 14px",
          borderRadius: 8,
          border: `1px solid ${tier ? withAlpha(tierColor, 0.5) : border}`,
          background: panel2,
          boxShadow: tier ? `0 0 16px ${withAlpha(tierColor, 0.12)}` : "none",
          cursor: result ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        {showImage ? (
          <img
            key={imageSrc}
            src={imageSrc}
            alt={tier || "Not enough data"}
            width={44}
            height={44}
            onError={() => setFailedSrc(imageSrc)}
            style={{ width: 44, height: 44, flexShrink: 0, objectFit: "cover", borderRadius: 8, border: `1px solid ${withAlpha(tierColor, 0.55)}` }}
          />
        ) : (
          <Gem size={22} color={tierColor} style={{ flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 2 }}>
            Diamond Hands Score
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: error ? errorColor : tierColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {statusText}
          </div>
          {result && <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>Hover or tap for your score</div>}
        </div>
      </button>

      {open && result && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 30,
            width: "min(560px, calc(100vw - 32px))",
            maxHeight: "70vh",
            overflowY: "auto",
            padding: 14,
            borderRadius: 10,
            border: `1px solid ${border}`,
            background: panel,
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <ScoreCardBody label={label} result={result} />
          <MethodologyText />
        </div>
      )}
    </div>
  );
}

// Core tier's Diamond Hands Score — a gamified holding-BEHAVIOR score (not a PnL figure), for the
// portfolio (combined across covered wallets) or one wallet. Built entirely from the exact same FIFO
// ledger the live PnL snapshot and PnL Statement already use (see
// backend/services/diamondHandsService.js's own header comment) -- this can never disagree with
// those about what was actually held/disposed, only adds a different lens on top of it. Fetches,
// then renders DiamondHandsCard for whatever the page-wide wallet filter has picked.
export default function CoreTierDiamondHandsCard({ wallet, getAuthParams, hasAccess, active, walletFilter }) {
  const { getDiamondHandsScore } = useDiamondHandsScore();
  const [result, setResult] = useState(null); // { asOf, portfolio, perWallet, perAsset, failed } | null
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadResult = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setResult(await getDiamondHandsScore(wallet.account, signature, timestamp));
    } catch (err) {
      console.error("Failed to load Diamond Hands score:", err.message);
      setError(err.message || "Couldn't compute your Diamond Hands score");
    } finally {
      setLoading(false);
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
    <DiamondHandsCard
      result={scopeResult || null}
      label={walletFilter === "all" ? "Portfolio" : "This Wallet"}
      loading={loading}
      error={error || (filteredWalletFailed ? "failed" : null)}
    />
  );
}
