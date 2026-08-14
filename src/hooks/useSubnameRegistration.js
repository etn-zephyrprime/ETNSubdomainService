import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, MARKETPLACE_DEPLOY_BLOCK, NAME_WRAPPER_ADDRESS, RPC_URL, R2_PUBLIC_URL } from "../config.js";
import { computeSubnode, decodeFirstLabel } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";

// The public RPC's actual eth_getLogs block-range cap isn't fixed — it's tolerated ~8,300 blocks
// once, then started rejecting ranges over ~1,000 a couple of days later with no code change on
// our end (shared/load-balanced gateway, likely per-node or load-dependent policy). Querying the
// whole MARKETPLACE_DEPLOY_BLOCK-to-latest range in one shot is therefore not reliable long-term
// regardless of what size is hardcoded, so this chunks the scan and halves the window on a
// range-rejection instead of assuming any fixed size will keep working. Chunks run concurrently
// (bounded) rather than one at a time — this is only ever the fallback path now (see
// getAvailableParentDomains below), but still meaningfully faster than sequential when it does run
// (confirmed ~112 chunks needed as of writing for the full history). Results are reassembled in
// chunk (= block) order before being returned, regardless of which chunk's request finishes first.
//
// Each worker's inner loop must fully WALK its assigned [rangeStart, rangeEnd] — advancing a
// cursor after every successful sub-fetch and only shrinking the sub-fetch size (never `end`) on a
// range-rejection. An earlier version shrunk `end` on rejection and broke out after the first
// (now-smaller) fetch succeeded, silently discarding whatever blocks that left uncovered between
// the shrunk end and the original one — confirmed live: a whole domain's SubnamePricePerYearSet
// events (community.etn) went missing from the "domains selling subnames" list this way, since
// they happened to sit past a rejected chunk's shrink point. Fixed by tracking cursor/rangeEnd
// separately from the sub-fetch size, so a shrink retries forward from where it left off instead
// of abandoning the remainder.
//
// Once shrunk to the floor, a further rejection gets a few backoff-and-retry attempts before
// finally giving up — confirmed live: Ankr's public RPC returned "Block range is too large" for a
// 25-block range, which can't genuinely be too large, so a rejection at the floor reads as
// transient rate-limiting mislabeled with a range-flavored message rather than a real signal to
// shrink further (there's nowhere smaller to go anyway).
const MIN_CHUNK_SIZE = 50;
const MAX_FLOOR_RETRIES = 6;
const FLOOR_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, concurrency = 8) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }

  const results = new Array(ranges.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= ranges.length) return;
      const [rangeStart, rangeEnd] = ranges[i];
      const events = [];
      let cursor = rangeStart;
      let size = rangeEnd - rangeStart + 1;
      let floorRetries = 0;

      while (cursor <= rangeEnd) {
        const end = Math.min(cursor + size - 1, rangeEnd);
        try {
          const chunk = await contract.queryFilter(filter, cursor, end);
          events.push(...chunk);
          cursor = end + 1;
          floorRetries = 0; // reset backoff once any fetch succeeds
        } catch (err) {
          const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
          const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
          if (!isRangeError) throw err;

          if (size > MIN_CHUNK_SIZE) {
            size = Math.max(MIN_CHUNK_SIZE, Math.floor(size / 2));
            continue; // retry the same `cursor` with the smaller window
          }

          floorRetries++;
          if (floorRetries > MAX_FLOOR_RETRIES) throw err;
          await sleep(FLOOR_RETRY_BASE_DELAY_MS * floorRetries);
          continue;
        }
      }

      results[i] = events;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  return results.flat();
}

// Scans SubnamePricePerYearSet events directly, scoped to MARKETPLACE_DEPLOY_BLOCK since the
// public RPC rejects unscoped fromBlock queries ("Block range is too large"), and chunked (see
// queryLogsChunked) since even a scoped range isn't reliably small enough on its own. Labels come
// from NameWrapper.names(node) (the same on-chain source the contract itself trusts), not from
// the event — SubnamePricePerYearSet only carries the hashed node. Only reached as a fallback now
// (see getAvailableParentDomains) — the normal path fetches backend/utils/subnameDomainsCache.js's
// published result instead of running this scan in every visitor's browser.
async function scanAvailableParentDomainsOnChain({ marketplace, nameWrapper }) {
  const latestBlock = await marketplace.runner.getBlockNumber();
  const events = await queryLogsChunked(
    marketplace,
    marketplace.filters.SubnamePricePerYearSet(),
    MARKETPLACE_DEPLOY_BLOCK,
    latestBlock
  );

  // Ascending (block, logIndex) order — queryLogsChunked's chunks are reassembled in block order
  // regardless of completion timing, so a plain overwrite keeps each node's latest rate, including
  // 0 for domains that turned subname sales back off.
  const latestPriceByNode = new Map();
  for (const event of events) {
    latestPriceByNode.set(event.args.parentNode, event.args.pricePerYear);
  }

  const activeNodes = [...latestPriceByNode.entries()].filter(([, pricePerYear]) => pricePerYear > 0n);

  const domains = await Promise.all(
    activeNodes.map(async ([node, pricePerYear]) => {
      const encoded = await nameWrapper.names(node);
      const label = decodeFirstLabel(encoded);
      return label ? { label, node, pricePerYear } : null;
    })
  );

  return domains.filter(Boolean);
}

export function useSubnameRegistration() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, provider),
    };
  }, []);

  const getSubnamePricePerYear = useCallback(async (parentNode) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePricePerYear(parentNode);
  }, [getReadContracts]);

  const quoteSubname = useCallback(async (parentNode, duration) => {
    const { marketplace } = getReadContracts();
    return await marketplace.quoteSubname(parentNode, duration);
  }, [getReadContracts]);

  // A subname's expiry can never exceed its parent's — used to filter which duration presets are
  // even offerable for a given parent.
  const getParentExpiry = useCallback(async (parentNode) => {
    const { nameWrapper } = getReadContracts();
    const data = await nameWrapper.getData(parentNode);
    return data.expiry;
  }, [getReadContracts]);

  const checkSubnameAvailable = useCallback(async (parentNode, label) => {
    const { nameWrapper } = getReadContracts();
    const subNode = computeSubnode(parentNode, label);
    const owner = await nameWrapper.ownerOf(subNode);
    return owner === ethers.ZeroAddress;
  }, [getReadContracts]);

  // backend/utils/subnameDomainsCache.js keeps a small public JSON file in R2 with exactly this —
  // scanned server-side on a timer instead of by every visitor's browser on every page load (that
  // full-history scan is ~112 chunked RPC round trips as of writing, and grows by roughly one more
  // every day, forever). One plain fetch here instead. Falls back to scanning on-chain directly —
  // scanAvailableParentDomainsOnChain below, unchanged in substance from before this cache existed
  // — if R2_PUBLIC_URL isn't configured, the cache hasn't been published yet, or the fetch fails
  // for any reason (network hiccup, stale deploy, etc.): slower in that case, but never broken.
  const getAvailableParentDomains = useCallback(async () => {
    if (R2_PUBLIC_URL) {
      try {
        const res = await fetch(`${R2_PUBLIC_URL.replace(/\/$/, "")}/subname-domains.json`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.domains)) {
            return data.domains.map((d) => ({ ...d, pricePerYear: BigInt(d.pricePerYear) }));
          }
        }
      } catch (err) {
        console.warn("Subname domains cache fetch failed, falling back to on-chain scan:", err.message);
      }
    }

    return scanAvailableParentDomainsOnChain(getReadContracts());
  }, [getReadContracts]);

  const registerSubname = useCallback(async (parentNode, label, duration, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in
      // this app (registerName ran out of gas at its auto-estimated limit), so writes use a
      // fixed generous limit instead of trusting the wallet's estimate.
      const tx = await marketplace.registerSubname(parentNode, label, duration, { value: priceWei, gasLimit: 450000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Registration failed");

      const subNode = computeSubnode(parentNode, label);
      return { success: true, txHash: tx.hash, subNode };
    } catch (err) {
      console.error("Subname registration failed:", err);
      setError(err?.reason || err?.message || "Registration failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getSubnamePricePerYear,
    quoteSubname,
    getParentExpiry,
    checkSubnameAvailable,
    getAvailableParentDomains,
    registerSubname,
    loading,
    error,
  };
}
