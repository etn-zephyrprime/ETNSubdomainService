import React from "react";
import { ethers } from "ethers";
import { useEtnPrice } from "../hooks/useEtnPrice.js";
import { useTokenPrices } from "../hooks/useTokenPrices.js";
import { muted } from "../styles/theme.js";

// Small "≈ $X.XX" label dropped next to a headline price. `etn` is a plain human-units amount (a
// number or numeric string, e.g. formatEth()'s output), not wei — the prop name predates
// multi-currency pricing and every existing ETN-only call site still passes it unchanged.
// `tokenAddress` is optional: omit it (or pass ethers.ZeroAddress) for an ETN amount, priced via
// useEtnPrice.js same as always; pass a whitelisted ERC20 payment token's address to price that
// amount instead, via useTokenPrices.js (backend/utils/tokenPriceCache.js's own ElectroSwap-backed
// cache) — same "renders nothing until/unless a price is actually available" fallback either way,
// so a caller can pass this unconditionally for ANY currency without its own loading/guard logic
// (see SubnameSearch.jsx's own quote display, which used to gate this to ETN-only for exactly that
// reason before token prices existed to fall back to).
export default function UsdEstimate({ etn, tokenAddress, style }) {
  const isToken = tokenAddress && tokenAddress !== ethers.ZeroAddress;

  const etnUsdPrice = useEtnPrice();
  const tokenPrices = useTokenPrices();
  const usdPrice = isToken ? tokenPrices.get(tokenAddress.toLowerCase()) ?? null : etnUsdPrice;

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
