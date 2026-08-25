import { ethers } from "ethers";

/** Formats a wei bigint as an ETN amount string rounded to 2 decimal places, for display. */
export function formatEth(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(2);
}

/** `0x1234...abcd` — same convention used throughout (Marketplace.jsx, useMarketplaceListings.js). */
export function shortAddress(address) {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * "342d 5h left" / "5h 12m left" / "Expired" — `expirySeconds` is a unix timestamp (seconds, as
 * NameWrapper.getData returns it), not milliseconds. Coarsens to the two largest relevant units
 * rather than showing a full breakdown — this is a glanceable table cell, not a countdown timer.
 */
export function formatTimeLeft(expirySeconds) {
  const msLeft = expirySeconds * 1000 - Date.now();
  if (msLeft <= 0) return "Expired";

  const minutes = Math.floor(msLeft / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years}y ${days % 365}d left`;
  if (days > 0) return `${days}d ${hours % 24}h left`;
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  return `${Math.max(1, minutes)}m left`;
}

/** True if `expirySeconds` (unix seconds) is already in the past. */
export function isExpired(expirySeconds) {
  return expirySeconds * 1000 <= Date.now();
}
