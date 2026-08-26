import React from "react";
import { useEtnPrice } from "../hooks/useEtnPrice.js";
import { muted } from "../styles/theme.js";

// Small "≈ $X.XX" label dropped next to a headline ETN price — `etn` is a plain human-units
// amount (a number or numeric string, e.g. formatEth()'s output), not wei. Renders nothing while
// the price hasn't loaded yet (see useEtnPrice.js) or `etn` isn't a positive finite number, so a
// caller can pass this unconditionally without its own loading/guard logic.
export default function UsdEstimate({ etn, style }) {
  const usdPrice = useEtnPrice();
  const amount = typeof etn === "string" ? parseFloat(etn) : etn;

  if (usdPrice === null || !Number.isFinite(amount) || amount <= 0) return null;

  const usd = amount * usdPrice;
  // Sub-cent amounts (a lot of subname prices are a few ETN, worth well under a cent at ETN's
  // current price) read better as "<$0.01" than a misleadingly precise "$0.00".
  const display = usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <span style={{ fontSize: 12, color: muted, fontWeight: 500, ...style }}>
      ≈ {display}
    </span>
  );
}
