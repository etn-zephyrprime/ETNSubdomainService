import React, { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { formatCompact, formatTokenAmount, shortHash } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { ElectroSwap } from "../../../backend/assets/media.js";
import TokenPriceChart from "./TokenPriceChart.jsx";

// ElectroSwap's two different per-asset URL shapes — a trading page for fungible tokens, a
// collection page for NFTs — same distinction TokenLeaderboard.jsx's NFT-row link uses.
function electroSwapUrl(token) {
  const isNft = token.type === "ERC-721" || token.type === "ERC-1155";
  return isNft
    ? `https://app.electroswap.io/collection/${token.address}`
    : `https://app.electroswap.io/explore/tokens/electroneum/${token.address}?inputCurrency=ETN`;
}

// Raw-BigInt percentage (basis-points precision, so a whale showing "0.00%" from float rounding
// isn't possible) rather than doing the division on formatTokenAmount's already-decimal-shifted
// display strings, which would lose precision for large supplies. null when total supply is
// missing/zero — a holder row just omits the percentage rather than showing "NaN%" or "Infinity%".
function holderPercentage(value, totalSupply) {
  try {
    const total = BigInt(totalSupply);
    if (total <= 0n) return null;
    const basisPoints = (BigInt(value) * 10000n) / total;
    return Number(basisPoints) / 100;
  } catch {
    return null;
  }
}

export default function TokenDetail({ address, onBack, onSelectAddress }) {
  const { getToken, getTokenHolders } = useBlockscout();

  const [token, setToken] = useState(null);
  const [holders, setHolders] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setToken(null);
    setHolders([]);
    setError(null);
    (async () => {
      try {
        const [tokenRes, holdersRes] = await Promise.all([getToken(address), getTokenHolders(address)]);
        if (cancelled) return;
        setToken(tokenRes);
        setHolders(holdersRes.items || []);
      } catch (err) {
        console.error("Failed to load token detail:", err);
        if (!cancelled) setError("Couldn't load this token — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [address, getToken, getTokenHolders]);

  return (
    <div>
      <button
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: green, background: "transparent", border: "none", cursor: "pointer", marginBottom: 16, padding: 0 }}
      >
        <ArrowLeft size={14} /> Back to Tokens
      </button>

      {error ? (
        <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>
      ) : !token ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Loading…</div>
      ) : (
        <>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>
              {token.name || "Unnamed Token"} <span style={{ color: mutedLight, fontWeight: 500 }}>{token.symbol}</span>
            </div>
            <a
              href={`${EXPLORER_BASE_URL}/token/${token.address}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: mutedLight, fontFamily: "monospace", textDecoration: "none", borderBottom: `1px solid ${border}` }}
            >
              {token.address}
            </a>
            <div>
              <a
                href={electroSwapUrl(token)}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: green, fontWeight: 700, textDecoration: "none" }}
              >
                <img src={ElectroSwap} alt="" style={{ height: 14, width: 14, objectFit: "contain", borderRadius: 3 }} />
                View on ElectroSwap ↗
              </a>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
            <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
              <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>Holders</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatCompact(token.holders)}</div>
            </div>
            <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
              <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>Total Supply</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatTokenAmount(token.total_supply, token.decimals)}</div>
            </div>
            <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
              <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>Type</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{token.type}</div>
            </div>
          </div>

          <TokenPriceChart address={token.address} decimals={token.decimals} totalSupply={token.total_supply} />

          <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Top Holders
          </div>
          {holders.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>No holder data available.</div>
          ) : (
            holders.slice(0, 25).map((h) => {
              const pct = holderPercentage(h.value, token.total_supply);
              return (
                <button
                  key={h.address.hash}
                  onClick={() => onSelectAddress(h.address.hash)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "8px 0", borderBottom: `1px solid ${border}`, background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
                >
                  <span style={{ fontSize: 12, color: "#fff", fontFamily: "monospace" }}>
                    {h.address.ens_domain_name || shortHash(h.address.hash)}
                  </span>
                  <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                    {formatTokenAmount(h.value, token.decimals)}
                    {pct != null && <span style={{ color: mutedLight, fontWeight: 500 }}> ({pct.toFixed(2)}%)</span>}
                  </span>
                </button>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
