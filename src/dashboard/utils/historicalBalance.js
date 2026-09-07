import { ethers } from "ethers";
import { RPC_URL } from "../../config.js";
import { EXPLORER_BASE_URL } from "../config.js";

// Backfills CoreTierBalanceHistory.jsx's rolling-12-month chart for the stretch older than
// Blockscout's coin-balance-history-by-day endpoint retains — confirmed live: that endpoint's
// oldest entry is ~90 days back REGARDLESS of an address's actual age (tested against a contract
// active since near this chain's genesis; it returned the exact same cutoff date as an unrelated
// 3-month-old wallet) — a deliberate retention window on Blockscout's side, not "this address
// wasn't active before then". buildDailySeries's/mergeBalanceHistories's own "0 before the first
// entry" default is therefore wrong for any wallet older than that window: it draws a flat zero
// over a stretch where the wallet could easily have held a real, nonzero balance.
//
// This resolves the wallet's REAL balance at the block closest to `windowDays` ago via a direct
// eth_getBalance historical-state read — confirmed live: Ankr's endpoint (this app's primary RPC,
// src/config.js's RPC_URL) serves this correctly at least ~150 days back; the secondary/fallback
// RPC does NOT (a pruned, non-archive node — returns "missing trie node"). One RPC call per
// wallet per chart load, not per day, so this is the same "a one-off direct call is fine from the
// browser" reasoning useReverseRecord.js's own RPC usage already relies on — nothing like
// GeckoTerminal's fragile shared rate limit that actually needed a backend proxy.
const cache = new Map(); // `${address}|${windowDays}` -> Promise<number|null> | number | null

async function getBlockNumberBefore(date) {
  const unixSeconds = Math.floor(date.getTime() / 1000);
  const res = await fetch(
    `${EXPLORER_BASE_URL}/api?module=block&action=getblocknobytime&timestamp=${unixSeconds}&closest=before`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} resolving block by timestamp`);
  const json = await res.json();
  if (json.status !== "1" || !json.result?.blockNumber) {
    throw new Error(`Unexpected response resolving block by timestamp: ${JSON.stringify(json)}`);
  }
  return Number(json.result.blockNumber);
}

/**
 * `address`'s real ETN balance at approximately `windowDays` ago, or null if it can't be
 * determined (the chain didn't exist that far back yet, the RPC doesn't retain that state, a
 * transient failure, etc). Callers treat null the same as the previous "assume 0" behavior rather
 * than failing the whole chart over it — this is a best-effort backfill, not a hard dependency.
 * Cached per (address, windowDays) for the life of the page.
 */
export async function getHistoricalBalance(address, windowDays) {
  const key = `${address.toLowerCase()}|${windowDays}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const promise = (async () => {
    try {
      const targetDate = new Date();
      targetDate.setUTCDate(targetDate.getUTCDate() - windowDays);
      const blockNumber = await getBlockNumberBefore(targetDate);

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const balanceWei = await provider.getBalance(address, blockNumber);
      return parseFloat(ethers.formatEther(balanceWei));
    } catch (err) {
      console.warn(`Couldn't resolve historical balance for ${address} at ${windowDays}d ago:`, err.message);
      return null;
    }
  })();

  cache.set(key, promise);
  const result = await promise;
  cache.set(key, result); // replace the in-flight promise with its settled value
  return result;
}
