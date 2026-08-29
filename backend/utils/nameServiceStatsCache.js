import { ethers } from "ethers";
import { getNameServiceStatsCache, setNameServiceStatsCache } from "../state/nameServiceStatsState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Keeps a small public JSON cache of proprietary .etn Name Service activity in R2, for the
// dashboard's "Name Service" tab — data Blockscout's own /stats page has no way to show at all,
// since it only sees raw on-chain addresses/transactions, not this app's naming layer on top.
// Domain/subname *counts* and "top domains by subname count" don't need anything new here — those
// already come straight out of activatedDomainsCache.js's published data on the frontend side.
// What genuinely doesn't exist anywhere yet is *timestamped* history (for a registrations-per-day
// trend chart) and marketplace sale/floor-price data — Blockscout's logs endpoint confirmed live
// to omit block timestamps entirely, and nothing in this backend persists sale prices over time —
// both filled in here.
//
// Deliberately its own independent scanner (own cursor, own duplicated queryLogsChunked) rather
// than piggybacking on ownedNamesCache.js's existing scan of the same three event types — same
// "fine to drift independently" philosophy already established for the several other copies of
// this helper in this codebase. Keeps this cache's failure/disablement fully decoupled from
// ownedNamesCache.js's.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15207471;
// BaseRegistrarImplementation — the canonical, chain-level registrar every .etn top-level domain
// is minted through, regardless of which frontend/app was used. Added so this tab can show real
// network-wide registration activity, not just the subset that happened to also flow through this
// app's Marketplace contract (confirmed live: 90 real NameRegistered events on this contract vs.
// only 4 domains this app's own Marketplace ever saw — most .etn registrations never touch this
// app at all). Deployed before the Marketplace contract (confirmed via its earliest transaction,
// block 15031631, one block before its own earliest NameRegistered event) — MARKETPLACE_DEPLOY_BLOCK
// alone would miss all pre-Marketplace history.
const BASE_REGISTRAR_ADDRESS = process.env.BASE_REGISTRAR_ADDRESS || "0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59";
const BASE_REGISTRAR_DEPLOY_BLOCK = process.env.BASE_REGISTRAR_DEPLOY_BLOCK
  ? parseInt(process.env.BASE_REGISTRAR_DEPLOY_BLOCK, 10)
  : 15031631;
// Earlier of the two — the scan's actual starting point (see the cursor-bootstrap logic below).
const EARLIEST_DEPLOY_BLOCK = Math.min(MARKETPLACE_DEPLOY_BLOCK, BASE_REGISTRAR_DEPLOY_BLOCK);
// Bumped from the unversioned v1 (Marketplace-only) shape: a cache published before this change
// already has `lastScannedBlock` advanced past MARKETPLACE_DEPLOY_BLOCK, which would silently
// skip the entire BaseRegistrar pre-Marketplace block range forever (the cursor logic below only
// bootstraps from EARLIEST_DEPLOY_BLOCK when there's *no* valid cache) — same fix shape as
// ownedNamesCache.js's CACHE_SCHEMA_VERSION history.
const CACHE_SCHEMA_VERSION = 2;
const CACHE_INTERVAL_MS = process.env.NAME_SERVICE_STATS_CACHE_INTERVAL_MS
  ? parseInt(process.env.NAME_SERVICE_STATS_CACHE_INTERVAL_MS, 10)
  : 300000;
const MAX_BLOCKS_PER_CYCLE = process.env.NAME_SERVICE_STATS_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.NAME_SERVICE_STATS_MAX_BLOCKS_PER_CYCLE, 10)
  : 50000;
// Bounds the published event history's long-term growth — generous relative to this ecosystem's
// actual current scale (a few dozen events total at the time this was built), just not literally
// unbounded forever. Oldest events drop off first; the trend chart only ever looks at a recent
// window anyway (see NameServiceStats.jsx).
const MAX_HISTORY_EVENTS = 2000;
const TIMESTAMP_CONCURRENCY = 8;

const MARKETPLACE_ABI = [
  "event NameRegistered(address indexed buyer, string label, uint256 basePrice, uint256 brokerageFee, address wrappedTo, uint16 fuses)",
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
// Standard ENS-style BaseRegistrarImplementation shape — confirmed live against the real
// contract. Deliberately no plaintext label: this event only ever carries the hashed tokenId
// (`id`), same fundamental limitation already documented in ownedNamesCache.js for "retro" names
// — there's no way to recover a name from this alone unless it's *also* independently wrapped via
// NameWrapper at some point. Fine here: this is used only for an accurate network-wide count/
// trend, not a name list.
const BASE_REGISTRAR_ABI = [
  "event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)",
];

const MIN_CHUNK_SIZE = 50;
const MAX_FLOOR_RETRIES = 6;
const FLOOR_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same range-adaptive chunked/concurrent log scan as this repo's other caches — see
// subnameDomainsCache.js's comment for the full reasoning. Duplicated rather than shared.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, concurrency = 4) {
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
          floorRetries = 0;
        } catch (err) {
          const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
          const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
          if (!isRangeError) throw err;

          if (size > MIN_CHUNK_SIZE) {
            size = Math.max(MIN_CHUNK_SIZE, Math.floor(size / 2));
            continue;
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

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

let isRunning = false;

async function scanAndPublish(marketplace, baseRegistrar, provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getNameServiceStatsCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const events = Array.isArray(cached?.events) ? cached.events.slice() : [];

    const fromBlock = cached?.lastScannedBlock ? cached.lastScannedBlock + 1 : EARLIEST_DEPLOY_BLOCK;
    const latestBlock = await marketplace.runner.getBlockNumber();
    const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_CYCLE - 1, latestBlock);

    if (fromBlock <= latestBlock) {
      const [registered, activated, subnamesReg, sold, networkRegistered] = await Promise.all([
        queryLogsChunked(marketplace, marketplace.filters.NameRegistered(), fromBlock, toBlock),
        queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), fromBlock, toBlock),
        queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), fromBlock, toBlock),
        queryLogsChunked(marketplace, marketplace.filters.ListingSold(), fromBlock, toBlock),
        queryLogsChunked(baseRegistrar, baseRegistrar.filters.NameRegistered(), fromBlock, toBlock),
      ]);
      const allEvents = [...registered, ...activated, ...subnamesReg, ...sold, ...networkRegistered].sort(
        (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
      );

      if (allEvents.length > 0) {
        // Dedup timestamp lookups by block — several events can share a block (e.g. a batch of
        // registrations in one tx), and this chain's public RPC rejects request batching
        // (batchMaxCount: 1 below), so each unique lookup is its own round trip.
        const uniqueBlocks = [...new Set(allEvents.map((e) => e.blockNumber))];
        const blockTimestamps = new Map();
        await mapWithConcurrency(uniqueBlocks, TIMESTAMP_CONCURRENCY, async (blockNumber) => {
          try {
            const block = await provider.getBlock(blockNumber);
            blockTimestamps.set(blockNumber, block ? block.timestamp * 1000 : null);
          } catch (err) {
            console.warn(`⚠️  Name Service stats: failed to fetch timestamp for block ${blockNumber}:`, err.message);
            blockTimestamps.set(blockNumber, null);
          }
        });

        const baseRegistrarAddrLc = BASE_REGISTRAR_ADDRESS.toLowerCase();

        for (const event of allEvents) {
          const timestampMs = blockTimestamps.get(event.blockNumber);
          if (timestampMs == null) continue; // couldn't get a real timestamp — skip rather than fake one

          // Both contracts happen to emit an event literally named "NameRegistered", with
          // different shapes (Marketplace's carries a plaintext label; BaseRegistrar's only ever
          // carries a hashed tokenId — see BASE_REGISTRAR_ABI's comment) — disambiguated by which
          // contract actually emitted it (event.address), not just the event name.
          const isNetworkRegistration = event.eventName === "NameRegistered" && event.address?.toLowerCase() === baseRegistrarAddrLc;

          if (isNetworkRegistration) {
            events.push({ type: "network_domain_registered", timestampMs });
          } else if (event.eventName === "NameRegistered") {
            events.push({ type: "domain_registered", label: event.args.label, timestampMs });
          } else if (event.eventName === "DomainActivated") {
            events.push({ type: "domain_activated", timestampMs });
          } else if (event.eventName === "SubnameRegistered") {
            events.push({ type: "subname_registered", label: event.args.label, priceWei: event.args.price.toString(), timestampMs });
          } else if (event.eventName === "ListingSold") {
            // txHash included so the frontend can link each sale straight to the block explorer —
            // no name/label available here either (ListingSold carries a listingId, not a label;
            // resolving one would mean an extra per-sale contract call this cache doesn't
            // otherwise need), so the link is the primary way to see what actually sold.
            events.push({ type: "listing_sold", priceWei: event.args.price.toString(), timestampMs, txHash: event.transactionHash });
          }
        }
      }
    } else {
      console.log("📡 Name Service stats: already caught up, refreshing live listings snapshot only");
    }

    // Trim to the most recent MAX_HISTORY_EVENTS — oldest drop off first.
    const trimmedEvents = events.length > MAX_HISTORY_EVENTS ? events.slice(events.length - MAX_HISTORY_EVENTS) : events;

    // Floor price / active listing count — a live read (same nextListingId/listings() pattern
    // marketplaceSellersCache.js uses), not derived from the event log above. Reconstructing
    // "currently active" from ExistingNameListed/ListingSold/ListingCancelled events would be
    // fragile (reorg edge cases, event-processing-order bugs); reading the contract's own current
    // state directly is what the site's live Marketplace page already trusts.
    let floorPriceWei = null;
    let activeListingsCount = 0;
    try {
      const nextId = await marketplace.nextListingId();
      const count = Number(nextId) - 1;
      if (count > 0) {
        const ids = Array.from({ length: count }, (_, i) => i + 1);
        const raw = await mapWithConcurrency(ids, TIMESTAMP_CONCURRENCY, (id) => marketplace.listings(id));
        const active = raw.filter((l) => l.active);
        activeListingsCount = active.length;
        if (active.length > 0) {
          floorPriceWei = active.reduce((min, l) => (l.price < min ? l.price : min), active[0].price).toString();
        }
      }
    } catch (err) {
      console.warn("⚠️  Name Service stats: failed to read live listings snapshot:", err.message);
    }

    await setNameServiceStatsCache({
      events: trimmedEvents,
      floorPriceWei,
      activeListingsCount,
      lastScannedBlock: toBlock,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    console.log(`📡 Name Service stats cache updated — ${trimmedEvents.length} event(s) tracked, ${activeListingsCount} active listing(s), scanned to block ${toBlock}`);
  } catch (err) {
    console.error("⚠️  Name Service stats scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startNameServiceStatsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — Name Service stats cache disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as this repo's other per-item-call-heavy caches.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const baseRegistrar = new ethers.Contract(BASE_REGISTRAR_ADDRESS, BASE_REGISTRAR_ABI, provider);

  console.log(`📡 Name Service stats cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(marketplace, baseRegistrar, provider);
  setInterval(() => scanAndPublish(marketplace, baseRegistrar, provider), CACHE_INTERVAL_MS);
}
