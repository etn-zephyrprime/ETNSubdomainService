import React, { useCallback, useEffect, useState } from "react";
import { Gem, ChevronDown, ChevronUp } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useDiamondHandsScore } from "../../hooks/useDiamondHandsScore.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { green, orange, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";

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

/** The three underlying numbers behind a score, plus the score/tier itself — same shape shown at
 * every drill-down level (portfolio, wallet, asset) per the build brief's own "never just the
 * score in isolation" requirement. */
function ScoreCard({ label, result }) {
  if (!result) return null;
  const { components, score, tier } = result;
  const tierColor = tier ? TIER_COLORS[tier] : mutedLight;

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 34, fontWeight: 900, color: tierColor, lineHeight: 1 }}>{fmtScore(score)}</div>
        <div style={{ fontSize: 15, fontWeight: 800, color: tierColor }}>{tier || "Not enough data yet"}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
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

  const perAsset = result?.perAsset || [];
  const { resolve: resolveTokenName } = useTokenNames(perAsset.map((a) => a.tokenAddress));

  // Asset filter -- local to this panel, same "self-heals to none if it falls out of scope"
  // reasoning as CoreTierNftPnl.jsx's own collection filter (a wallet-filter change or a refresh
  // with different results shouldn't leave this pointed at a token no longer in scope).
  const [assetFilterRaw, setAssetFilter] = useState("");
  const assetFilter = perAsset.some((a) => a.tokenAddress === assetFilterRaw) ? assetFilterRaw : "";
  const scopeAsset = assetFilter ? perAsset.find((a) => a.tokenAddress === assetFilter) : null;

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

        {scopeResult && (
          <>
            <ScoreCard label={walletFilter === "all" ? "Portfolio" : "This Wallet"} result={scopeResult} />

            {perAsset.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ ...sectionHeaderStyle, display: "flex", alignItems: "center", gap: 6 }}>
                  By Asset
                  <InfoTooltip text="Drill into one token (or native ETN) to see its own holding-period, retention, and panic-sell numbers, rather than the portfolio-wide blend above." />
                </div>
                <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} style={{ ...selectStyle, width: "100%", marginBottom: 12 }}>
                  <option value="">All Assets (combined, above)</option>
                  {perAsset.map((a) => (
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
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
