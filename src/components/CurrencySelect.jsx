import React from "react";
import { ethers } from "ethers";

// ETN is always implicitly payable for PRICING/ACTIVATION on V5 (it never appears in
// whitelistedPaymentTokens — see PlanetZephyrosSubdomainServiceV5.sol's own comment on that
// mapping), but that does NOT mean every individual domain is actually FOR SALE in ETN — a
// domain owner sets each currency's price independently, and can price in only a token, never
// ETN. So this constant is exported for callers to include when ETN is genuinely a valid option
// for their own context (e.g. ManageSubdomain.jsx's own pricing/activation forms, where the
// connected owner can always choose to price/pay in ETN), but this component itself does NOT
// auto-prepend it — see this component's own comment below for why that used to be a real bug.
export const ETN_OPTION = { symbol: "ETN", address: ethers.ZeroAddress, decimals: 18 };

// Shared currency <select> — same input-field visual language as the rest of this app's forms
// (see ManageSubdomain.jsx/PayFlow.jsx's own inline input styles). `tokens` is the COMPLETE list
// of options to render, in order — the caller decides whether ETN_OPTION belongs in it at all.
// Deliberately NOT auto-prepending ETN_OPTION here (an earlier version of this component did):
// SubnameSearch.jsx's buyer-side picker only offers whichever currencies a SPECIFIC domain is
// actually priced in, which may or may not include ETN — auto-adding it there would have let a
// buyer select ETN for a domain never priced in it, silently compute a phantom 0-price quote, and
// hit a confusing on-chain "Subnames not for sale in this token" revert instead of a clear
// client-side message. `value`/`onChange` work on the token's address (a string), matching how
// every consumer already threads a `paymentToken` address through the contract-calling hooks.
export default function CurrencySelect({ tokens, value, onChange, disabled = false, style = {} }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "12px 14px",
        borderRadius: 999,
        border: `1px solid rgba(62,166,255,0.25)`,
        background: "rgba(255,255,255,0.05)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        color: "#fff",
        fontSize: 14,
        fontWeight: 600,
        boxSizing: "border-box",
        outline: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        // The open dropdown list itself is native browser chrome, not this element's own CSS box
        // — its background/text colors come from the OS's light/dark native-control theme, not
        // from anything set above, which only styles the closed control. Without this, a
        // light-mode OS renders that popup white-on-black-text regardless of how dark this page
        // is, making the token list unreadable against everything else here. `color-scheme: dark`
        // tells the browser to render this element's native chrome (the dropdown popup here) in
        // its dark variant instead.
        colorScheme: "dark",
        ...style,
      }}
    >
      {tokens.map((t) => (
        <option key={t.address} value={t.address}>
          {t.symbol}
        </option>
      ))}
    </select>
  );
}
