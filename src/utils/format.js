import { ethers } from "ethers";

/** Formats a wei bigint as an ETN amount string rounded to 2 decimal places, for display. */
export function formatEth(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(2);
}
