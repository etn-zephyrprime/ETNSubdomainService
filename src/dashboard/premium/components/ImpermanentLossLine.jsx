import React from "react";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { formatUsdPrice } from "../../utils/format.js";
import { muted, mutedLight, orange, green, error as errorColor } from "../../theme.js";

// Below this the loss is noise — shown neutral rather than alarming.
const NOTICEABLE_IL_PERCENT = -1;
// Beyond this it's shown in the error color.
const SEVERE_IL_PERCENT = -5;

const TOOLTIP =
  "How much less this position's tokens are worth now than if you'd simply held what you deposited, both at today's prices — before trading fees. " +
  "It grows the further the two tokens' prices move apart from where you entered, and shrinks back if they return (hence \"impermanent\"); it becomes real when you withdraw. " +
  "Full-range positions (V2 pools, yield farms) use the exact constant-product formula from your entry price ratio; concentrated (V3) positions compare values directly. " +
  "\"After fees\" adds back the trading fees you haven't collected yet. Blank when there's no deposit history to compare against.";

function pct(n) {
  const abs = Math.abs(n);
  return `${n < 0 ? "−" : ""}${abs < 0.01 && abs > 0 ? "<0.01" : abs.toFixed(2)}%`;
}

/** One-line impermanent-loss readout for an LP / V3 / farm position card. `il` is the position's
 * `impermanentLoss` field from the backend (backend/services/impermanentLoss.js) — renders nothing
 * when it's absent (single-token staking, no deposit baseline, or a cached result from before this
 * shipped). */
export default function ImpermanentLossLine({ il }) {
  if (!il || il.percent == null) return null;
  const percent = Number(il.percent);
  if (!Number.isFinite(percent)) return null;
  const color = percent <= SEVERE_IL_PERCENT ? errorColor : percent <= NOTICEABLE_IL_PERCENT ? orange : mutedLight;
  const usd = Number(il.lossUsd);
  const afterFees = il.afterFeesPercent != null ? Number(il.afterFeesPercent) : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", fontSize: 10, color: muted, marginTop: 3 }}>
      <span>Impermanent loss</span>
      <span style={{ color, fontWeight: 700 }}>{pct(percent)}</span>
      {Number.isFinite(usd) && usd < 0 && <span style={{ color }}>({`−${formatUsdPrice(Math.abs(usd))}`})</span>}
      {afterFees != null && Number.isFinite(afterFees) && (
        <span>
          · after fees <span style={{ color: afterFees >= 0 ? mutedLight : color, fontWeight: 700 }}>{afterFees >= 0 ? `+${afterFees.toFixed(2)}%` : pct(afterFees)}</span>
        </span>
      )}
      <InfoTooltip text={TOOLTIP} />
    </div>
  );
}

/** Farm card line: the live duration multiplier (backend defiPositionValuation.js farmMultipliers),
 * when it reaches its maximum, and the BOLT multiplier. Renders nothing without `multipliers`
 * (staking positions, or a cached result from before this shipped). */
export function FarmMultiplierLine({ multipliers }) {
  if (!multipliers || multipliers.durationMultiplier == null) return null;
  const { durationMultiplier, maxDurationMultiplier, maxReachedInDays, boltMultiplier } = multipliers;
  const atMax = durationMultiplier >= maxDurationMultiplier;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", fontSize: 10, color: muted, marginTop: 3 }}>
      <span>Duration multiplier</span>
      <span style={{ color: atMax ? green : mutedLight, fontWeight: 700 }}>{durationMultiplier.toFixed(2)}×</span>
      <span>{atMax ? "· maximum reached" : `· ${maxDurationMultiplier.toFixed(1)}× max in ${Math.ceil(maxReachedInDays)} day${Math.ceil(maxReachedInDays) === 1 ? "" : "s"}`}</span>
      {boltMultiplier > 1 && (
        <span>
          · BOLT <span style={{ color: mutedLight, fontWeight: 700 }}>{boltMultiplier.toFixed(2)}×</span>
        </span>
      )}
    </div>
  );
}
