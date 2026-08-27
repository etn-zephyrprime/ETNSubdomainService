import React, { useEffect, useState } from "react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { formatCompact, shortHash, isSpamTokenName } from "../utils/format.js";
import { ElectroSwap } from "../../../backend/assets/media.js";
import NeonButton from "../../components/NeonButton.jsx";

const CATEGORIES = [
  { id: "tokens", label: "Tokens", type: "ERC-20" },
  { id: "nfts", label: "NFT's", type: "ERC-721,ERC-1155" },
];

export default function TokenLeaderboard({ onSelectToken }) {
  const { getTokens } = useBlockscout();

  const [category, setCategory] = useState("tokens");
  const [tokens, setTokens] = useState([]);
  const [nextPageParams, setNextPageParams] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

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

  const visibleTokens = tokens.filter((t) => !isSpamTokenName(t.name));

  if (error) {
    return <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            style={{
              flex: "1 1 100px",
              padding: "8px 8px",
              borderRadius: 10,
              border: `1px solid ${c.id === category ? green : border}`,
              background: c.id === category ? "rgba(24,187,26,0.12)" : panel2,
              color: c.id === category ? green : mutedLight,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", padding: "0 12px 8px", fontSize: 11, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: 0.6 }}>
        <div style={{ flex: 1 }}>{category === "nfts" ? "Collection" : "Token"}</div>
        <div style={{ width: 100, textAlign: "right" }}>Holders</div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Loading…</div>
      ) : visibleTokens.length === 0 ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Nothing found.</div>
      ) : (
        visibleTokens.map((token) => (
          <div
            key={token.address}
            role="button"
            tabIndex={0}
            onClick={() => onSelectToken(token.address)}
            onKeyDown={(e) => { if (e.key === "Enter") onSelectToken(token.address); }}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "12px",
              marginBottom: 6,
              borderRadius: 10,
              background: panel2,
              border: `1px solid ${border}`,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {token.name || "Unnamed"} <span style={{ color: mutedLight, fontWeight: 500 }}>{token.symbol}</span>
              </div>
              <div style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(token.address)}</div>
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
            <div style={{ width: 100, textAlign: "right", fontSize: 13, fontWeight: 700, color: green, flexShrink: 0 }}>
              {formatCompact(token.holders)}
            </div>
          </div>
        ))
      )}

      {nextPageParams && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <NeonButton variant="dark" onClick={handleLoadMore} loading={loadingMore} style={{ padding: "8px 20px", fontSize: 12 }}>
            {loadingMore ? "Loading…" : "Load More"}
          </NeonButton>
        </div>
      )}
    </div>
  );
}
