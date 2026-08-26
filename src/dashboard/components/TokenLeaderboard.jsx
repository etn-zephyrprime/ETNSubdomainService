import React, { useEffect, useState } from "react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { formatCompact, shortHash } from "../utils/format.js";
import NeonButton from "../../components/NeonButton.jsx";

export default function TokenLeaderboard({ onSelectToken }) {
  const { getTokens } = useBlockscout();

  const [tokens, setTokens] = useState([]);
  const [nextPageParams, setNextPageParams] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getTokens();
        if (cancelled) return;
        setTokens(res.items || []);
        setNextPageParams(res.next_page_params || null);
      } catch (err) {
        console.error("Failed to load tokens:", err);
        if (!cancelled) setError("Couldn't load the token list — try refreshing shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [getTokens]);

  const handleLoadMore = async () => {
    if (!nextPageParams) return;
    setLoadingMore(true);
    try {
      const res = await getTokens(nextPageParams);
      setTokens((prev) => [...prev, ...(res.items || [])]);
      setNextPageParams(res.next_page_params || null);
    } catch (err) {
      console.error("Failed to load more tokens:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  if (error) {
    return <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", padding: "0 12px 8px", fontSize: 11, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: 0.6 }}>
        <div style={{ flex: 1 }}>Token</div>
        <div style={{ width: 100, textAlign: "right" }}>Holders</div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>Loading tokens…</div>
      ) : tokens.length === 0 ? (
        <div style={{ fontSize: 13, color: muted, textAlign: "center", padding: 24 }}>No tokens found.</div>
      ) : (
        tokens.map((token) => (
          <button
            key={token.address}
            onClick={() => onSelectToken(token.address)}
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
                {token.name || "Unnamed Token"} <span style={{ color: mutedLight, fontWeight: 500 }}>{token.symbol}</span>
              </div>
              <div style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(token.address)}</div>
            </div>
            <div style={{ width: 100, textAlign: "right", fontSize: 13, fontWeight: 700, color: green }}>
              {formatCompact(token.holders)}
            </div>
          </button>
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
