import React, { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { green, mutedLight, muted, panel2, border, error as errorColor, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { useTokenLiquidity } from "../hooks/useTokenLiquidity.js";
import { useTokenLocks } from "../hooks/useTokenLocks.js";
import { lockBadgeText } from "../utils/lockStatus.js";
import { formatCompact, formatUsdPrice, shortHash, isSpamTokenName } from "../utils/format.js";
import { ElectroSwap } from "../../../backend/assets/media.js";
import NeonButton from "../../components/NeonButton.jsx";

const TOP_TOKENS_SHOWN = 10; // Tokens tab: top N by liquidity (plus any with locked liquidity) before "Show more"

const CATEGORIES = [
  { id: "tokens", label: "Tokens", type: "ERC-20" },
  { id: "nfts", label: "NFT's", type: "ERC-721,ERC-1155" },
];

export default function TokenLeaderboard({ onSelectToken }) {
  const { getTokens } = useBlockscout();
  const liquidityByAddress = useTokenLiquidity();
  const locksByAddress = useTokenLocks();

  const [category, setCategory] = useState("tokens");
  const [tokens, setTokens] = useState([]);
  const [nextPageParams, setNextPageParams] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [showAllTokens, setShowAllTokens] = useState(false);

  const activeType = CATEGORIES.find((c) => c.id === category).type;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await getTokens(activeType);
        if (cancelled) return;
        setTokens(res.items || []);
        setNextPageParams(res.next_page_params || null);
      } catch (err) {
        console.error("Failed to load tokens:", err);
        if (!cancelled) setError("Couldn't load the list — try refreshing shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeType, getTokens]);

  const handleLoadMore = async () => {
    if (!nextPageParams) return;
    setLoadingMore(true);
    try {
      const res = await getTokens(activeType, nextPageParams);
      setTokens((prev) => [...prev, ...(res.items || [])]);
      setNextPageParams(res.next_page_params || null);
    } catch (err) {
      console.error("Failed to load more:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Sorted by total liquidity (USD) descending, per ElectroSwap's own listed-token data (see
  // useTokenLiquidity.js) — a far more useful default order than Blockscout's own ("in no
  // particular order" per that list's own creation-order-ish default), since a token with real,
  // deep liquidity is generally what a visitor actually cares about finding first. A token
  // ElectroSwap doesn't list at all (most of Blockscout's much broader, noisier "every ERC20 ever
  // deployed" list, including dead/spam tokens ElectroSwap never indexed) sorts to the bottom
  // rather than being hidden — still findable, just not competing with real, liquid tokens for the
  // top of the list. NFTs keep Blockscout's own order — ElectroSwap's fungible-token liquidity
  // figures don't apply to a collection.
  const visibleTokens = tokens
    .filter((t) => !isSpamTokenName(t.name))
    .map((t) => ({
      ...t,
      liquidityUsd: category === "tokens" ? liquidityByAddress.get(t.address?.toLowerCase()) ?? null : null,
      lockInfo: category === "tokens" ? locksByAddress.get(t.address?.toLowerCase()) ?? null : null,
    }))
    .sort((a, b) => {
      if (category !== "tokens") return 0;
      if (a.liquidityUsd == null && b.liquidityUsd == null) return 0;
      if (a.liquidityUsd == null) return 1;
      if (b.liquidityUsd == null) return -1;
      return b.liquidityUsd - a.liquidityUsd;
    });

  // Tokens tab only: collapse to the top 10 by liquidity plus every token with locked liquidity; the rest
  // sit behind "Show more". (Sorted above, so "top 10" is just the first 10.) NFTs are left as they were.
  const collapseTokens = category === "tokens" && !showAllTokens;
  const displayedTokens = collapseTokens
    ? visibleTokens.filter((t, i) => i < TOP_TOKENS_SHOWN || lockBadgeText(t.lockInfo))
    : visibleTokens;
  const hiddenTokenCount = category === "tokens" ? visibleTokens.length - displayedTokens.length : 0;

  if (error) {
    return <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>;
  }

  return (
    <div>
      <style>{`.dash-token-row{transition:border-color .15s ease,box-shadow .15s ease;} .dash-token-row:hover,.dash-token-row:focus-visible{border-color:${green};box-shadow:0 0 10px rgba(24,187,26,0.18);}`}</style>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {CATEGORIES.map((c) => {
          const isActive = c.id === category;
          return (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              style={{
                flex: "1 1 100px",
                padding: "8px 8px",
                borderRadius: 6,
                border: `1px solid ${isActive ? green : border}`,
                background: isActive ? "rgba(24,187,26,0.12)" : panel2,
                color: isActive ? green : mutedLight,
                fontFamily: monoFont,
                fontSize: 11,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", padding: "0 12px 8px", fontFamily: monoFont, fontSize: 10, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>
        <div style={{ flex: 1 }}>{category === "nfts" ? "Collection" : "Token"}</div>
        <div style={{ width: 100, textAlign: "right" }}>{category === "nfts" ? "Holders" : "Liquidity"}</div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Loading…</div>
      ) : visibleTokens.length === 0 ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Nothing found.</div>
      ) : (
        displayedTokens.map((token) => (
          <div
            key={token.address}
            role="button"
            tabIndex={0}
            className="dash-token-row"
            onClick={() => onSelectToken(token.address)}
            onKeyDown={(e) => { if (e.key === "Enter") onSelectToken(token.address); }}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "12px",
              marginBottom: 6,
              borderRadius: 4,
              background: panel2,
              border: `1px solid ${border}`,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {/* A collection shows its logo if it has one, but never a letter placeholder — most have
                    none, and a placeholder beside every one would just be noise. */}
                <TokenLogo address={token.address} label={token.symbol || token.name} size={22} placeholder={category === "tokens"} />
                {token.name || "Unnamed"} <span style={{ color: mutedLight, fontWeight: 500 }}>{token.symbol}</span>
              </div>
              <div style={{ fontSize: 11, color: mutedLight, fontFamily: monoFont }}>{shortHash(token.address)}</div>
              {category === "tokens" && lockBadgeText(token.lockInfo) && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: monoFont, fontSize: 10, fontWeight: 700, color: green, marginTop: 2 }}>
                  <Lock size={10} />
                  {lockBadgeText(token.lockInfo)}
                </div>
              )}
              {category === "nfts" && (
                <a
                  href={`https://app.electroswap.io/nfts/collection/${token.address}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: green, fontWeight: 700, textDecoration: "none" }}
                >
                  <img src={ElectroSwap} alt="" style={{ height: 12, width: 12, objectFit: "contain", borderRadius: 2 }} />
                  View on ElectroSwap ↗
                </a>
              )}
            </div>
            <div style={{ width: 100, textAlign: "right", flexShrink: 0 }}>
              {category === "nfts" ? (
                <span style={{ fontSize: 13, fontWeight: 700, color: green }}>{formatCompact(token.holders)}</span>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: green }}>
                    {token.liquidityUsd != null ? formatUsdPrice(token.liquidityUsd) : "—"}
                  </div>
                  <div style={{ fontSize: 11, color: mutedLight }}>{formatCompact(token.holders)} holders</div>
                </>
              )}
            </div>
          </div>
        ))
      )}

      {category === "tokens" && !loading && (hiddenTokenCount > 0 || showAllTokens) && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <NeonButton variant="dark" onClick={() => setShowAllTokens((v) => !v)} style={{ padding: "8px 20px", fontSize: 12 }}>
            {showAllTokens ? "Show fewer" : `Show ${hiddenTokenCount} more`}
          </NeonButton>
        </div>
      )}

      {nextPageParams && !collapseTokens && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <NeonButton variant="dark" onClick={handleLoadMore} loading={loadingMore} style={{ padding: "8px 20px", fontSize: 12 }}>
            {loadingMore ? "Loading…" : "Load More"}
          </NeonButton>
        </div>
      )}
    </div>
  );
}
