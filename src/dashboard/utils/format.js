import { ethers } from "ethers";

/** "154189614" -> "154.19M" — Blockscout returns big counters as decimal strings. */
export function formatCompact(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** Plain thousands-separated integer — for counts where "154,189,614" reads better than "154M". */
export function formatInt(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

/** A token amount in its own base units, formatted with that token's own `decimals` (not always
 * 18 — unlike every ETN amount elsewhere in this app, arbitrary ERC-20s vary). `decimals` is
 * null for NFTs (ERC-721/1155) — `value` there is already a plain count, not base units, so it's
 * used as-is rather than divided. Deliberately checked with `== null`, not `|| 18`: `Number(null)`
 * is 0, and `0 || 18` would silently substitute 18 anyway, dividing an NFT count down to an
 * unreadable near-zero fraction. */
export function formatTokenAmount(rawValue, decimals) {
  try {
    const d = decimals == null ? 0 : Number(decimals);
    const value = parseFloat(ethers.formatUnits(rawValue, Number.isFinite(d) ? d : 0));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return "—";
  }
}

/** Native ETN balance (always 18 decimals) — same rounding as this app's own formatEth. */
export function formatEtnBalance(wei) {
  try {
    return parseFloat(ethers.formatEther(wei)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return "—";
  }
}

// Airdrop-spam filter for token lists (TokenLeaderboard.jsx, AddressLookup.jsx's holdings) — a
// name-substring blocklist rather than anything cleverer, matching exactly what was asked for.
// Applied client-side since Blockscout's /tokens has no name-exclusion query param.
const SPAM_NAME_PATTERN = /dead|test|token/i;
export function isSpamTokenName(name) {
  return SPAM_NAME_PATTERN.test(name || "");
}

export function shortHash(hash, chars = 6) {
  if (!hash) return "";
  return `${hash.slice(0, chars)}...${hash.slice(-4)}`;
}

/** "2026-08-26T19:49:14Z" -> "3m ago" / "5h ago" / "2d ago" — Blockscout timestamps are ISO. */
export function timeAgo(isoString) {
  if (!isoString) return "";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
