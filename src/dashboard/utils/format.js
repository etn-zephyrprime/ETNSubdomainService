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
 * 18 — unlike every ETN amount elsewhere in this app, arbitrary ERC-20s vary). */
export function formatTokenAmount(rawValue, decimals) {
  try {
    const value = parseFloat(ethers.formatUnits(rawValue, Number(decimals) || 18));
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
