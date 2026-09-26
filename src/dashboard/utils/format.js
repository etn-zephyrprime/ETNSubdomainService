import { ethers } from "ethers";
import { getCurrentCurrencySnapshot } from "../hooks/useCurrency.js";

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

/** A USD figure in the viewer's chosen currency, abbreviated ("$217.7K") — for headline tiles where
 * the full "$217,723.41" would be noise. Same USD-in / display-currency-out contract as formatUsdPrice. */
export function formatUsdCompact(value) {
  if (!Number.isFinite(value)) return "—";
  const { symbol, rate } = getCurrentCurrencySnapshot();
  return `${symbol}${formatCompact(value * rate)}`;
}

/** ETN trades at a fraction of a cent, so a flat 2-decimal format would round it to "$0.00" —
 * shows enough decimals to actually be meaningful below a cent, plain 2-decimal above it.
 *
 * `value` is always USD in, regardless of the viewer's chosen display currency (every caller
 * across this app computes/stores figures in USD — this is the one place that converts for
 * display) — reads the dashboard's current currency/live rate (see useCurrency.js's own header
 * comment on why this is a plain function reading shared state rather than a hook) and formats
 * with that currency's own symbol. Falls back to a 1:1 USD-labeled-as-chosen-currency figure until
 * the live rate has loaded, same "degrade, don't break" convention as the rest of this app. */
export function formatUsdPrice(value) {
  if (!Number.isFinite(value)) return "—";
  const { symbol, rate } = getCurrentCurrencySnapshot();
  const converted = value * rate;
  if (converted === 0) return `${symbol}0`;
  if (Math.abs(converted) < 0.01) return `${symbol}${converted.toFixed(6)}`;
  return `${symbol}${converted.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** An ETN amount as a plain number: 2 decimals below 1,000,000, compact ("1M", "97.1M", "2.19B")
 * from 1,000,000 up — a 9-digit balance with cents is unreadable in a list row or chart stat, and the
 * cents mean nothing at that size. */
export function formatEtnAmount(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  }
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ETN amount abbreviated to K / M / BN with 2 decimals (1,234 -> "1.23K", 2,500,000 -> "2.50M",
 * 1.2e9 -> "1.20BN"); under 1,000 it's a plain 2-decimal number. Used on the Team Wallets tab. */
export function formatEtnShort(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}BN`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

/** formatEtnShort for a native wei amount (18 decimals). */
export function formatEtnShortWei(wei) {
  try {
    return formatEtnShort(parseFloat(ethers.formatEther(wei)));
  } catch {
    return "—";
  }
}

/** Native ETN balance (always 18 decimals) — see formatEtnAmount for the compact-over-1M rule. */
export function formatEtnBalance(wei) {
  try {
    return formatEtnAmount(parseFloat(ethers.formatEther(wei)));
  } catch {
    return "—";
  }
}

// Airdrop-spam filter for token lists (TokenLeaderboard.jsx, AddressLookup.jsx's holdings,
// CoreTierPortfolio.jsx, CoreTierPnl.jsx) — a name-substring blocklist rather than anything
// cleverer, matching exactly what was asked for. Applied client-side since Blockscout's /tokens
// has no name-exclusion query param. Also hand-copied into backend/utils/portfolioValuation.js
// (no shared build step between frontend/backend in this repo) — keep both in sync if this
// pattern ever changes.
const SPAM_NAME_PATTERN = /dead|test|token/i;
export function isSpamTokenName(name) {
  return SPAM_NAME_PATTERN.test(name || "");
}

export function shortHash(hash, chars = 6) {
  if (!hash) return "";
  return `${hash.slice(0, chars)}...${hash.slice(-4)}`;
}

/**
 * Chart axis/tooltip date formatting — `detailed` (SparklineChart's tooltip) gets a fuller
 * string than the compact one used for axis ticks. Handles both a plain "2026-08-26" day string
 * and a full ISO timestamp the same way (Date parses both), so the same formatter works for
 * daily-granularity series (e.g. coin-balance-history-by-day) and hourly ones
 * (dashboardStatsCache snapshots) alike — hourly series additionally show the hour, since a bare
 * date would repeat across every point in the same day.
 */
export function formatChartDate(label, detailed = false) {
  const date = new Date(label);
  if (Number.isNaN(date.getTime())) return String(label);

  const isHourly = typeof label === "string" && label.length > 10; // "2026-08-26" vs a full ISO timestamp
  const datePart = date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(detailed ? { year: "numeric" } : {}) });
  if (!isHourly) return datePart;

  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: detailed ? "2-digit" : undefined });
  return `${datePart}, ${timePart}`;
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
