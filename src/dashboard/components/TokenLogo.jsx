import React, { useState } from "react";
import { getTokenLogoUrl } from "../utils/tokenLogos.js";
import { border, mutedLight, panel2 } from "../theme.js";

// A token's logo as a small circle, sitting inline beside its name. Falls back to a neutral
// letter-in-a-circle placeholder for any token without a logo (or one that fails to load), so rows
// keep the same alignment whether or not a logo exists and there's never a broken-image icon.
//
// Decorative: every use is next to the token's own name, so the image is aria-hidden with empty alt
// rather than making a screen reader say the name twice.
//
// `label` (a symbol or name, optional) only feeds the placeholder's letter.
//
// `placeholder={false}` renders nothing at all when there's no logo — for NFT collections, most of
// which have none, where a letter-in-a-circle beside every row would just be noise. Fungible tokens
// keep the placeholder (the default) so their rows stay aligned.
export default function TokenLogo({ address, label, size = 20, spacing = 6, style, placeholder = true }) {
  const src = getTokenLogoUrl(address);
  // Keyed by src so a row that gets re-used for a different token retries instead of inheriting the
  // previous token's failed-to-load state.
  const [failedSrc, setFailedSrc] = useState(null);
  const showImage = Boolean(src) && failedSrc !== src;

  const base = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    verticalAlign: "middle",
    marginRight: spacing,
    overflow: "hidden",
    boxSizing: "border-box",
    ...style,
  };

  if (showImage) {
    return (
      <span style={{ ...base, background: "rgba(255,255,255,0.05)" }} aria-hidden="true">
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </span>
    );
  }

  if (!placeholder) return null;
  const letter = String(label || "").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      style={{ ...base, background: panel2, border: `1px solid ${border}`, color: mutedLight, fontSize: Math.max(8, Math.round(size * 0.5)), fontWeight: 800, lineHeight: 1 }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** Two (or more) tokens' logos overlapped, for an LP pair or a farm position. `legs` is the position's
 * own `legs` array ({ tokenAddress, symbol }). Each logo gets a ring in the row's background colour so
 * the overlap reads as two distinct marks rather than one smear. */
export function TokenPairLogo({ legs, size = 20, spacing = 8 }) {
  const shown = (legs || []).slice(0, 3);
  if (shown.length === 0) return null;
  const overlap = Math.round(size * 0.35);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", verticalAlign: "middle", marginRight: spacing }} aria-hidden="true">
      {shown.map((leg, i) => (
        <TokenLogo
          key={`${leg.tokenAddress}-${i}`}
          address={leg.tokenAddress}
          label={leg.symbol}
          size={size}
          spacing={0}
          style={{ marginLeft: i === 0 ? 0 : -overlap, boxShadow: `0 0 0 2px ${panel2}`, position: "relative", zIndex: shown.length - i }}
        />
      ))}
    </span>
  );
}
