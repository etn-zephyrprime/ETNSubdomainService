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
// Redeployed 2026-09-17 as V6 -- a SECURITY FIX, see src/config.js's own MARKETPLACE_ADDRESS
// comment. V5, V4, and V3 were all paused the same day and stay paused permanently.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15906639;
// BaseRegistrarImplementation — the canonical, chain-level registrar every .etn top-level domain
// is minted through, regardless of which frontend/app was used. Added so this tab can show real
// network-wide registration activity, not just the subset that happened to also flow through this
// app's Marketplace contract (confirmed live: 90 real NameRegistered events on this contract vs.
// only 4 domains this app's own Marketplace ever saw — most .etn registrations never touch this
// app at all). Deployed before the Marketplace contract (confirmed via its earliest transaction,
// block 15031631, one block before its own earliest NameRegistered event).
const BASE_REGISTRAR_ADDRESS = process.env.BASE_REGISTRAR_ADDRESS || "0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59";
const BASE_REGISTRAR_DEPLOY_BLOCK = process.env.BASE_REGISTRAR_DEPLOY_BLOCK
  ? parseInt(process.env.BASE_REGISTRAR_DEPLOY_BLOCK, 10)
  : 15031631;
// Bumped from the unversioned v1 (Marketplace-only) shape: a cache published before this change
// already has `lastScannedBlock` advanced past MARKETPLACE_DEPLOY_BLOCK, which would silently
// skip the entire BaseRegistrar pre-Marketplace block range forever (the cursor logic below only
// bootstraps from EARLIEST_DEPLOY_BLOCK when there's *no* valid cache) — same fix shape as
// ownedNamesCache.js's CACHE_SCHEMA_VERSION history.
// v3: added totalSellerRevenueWei (see its own comment below) — bumped again for the same reason:
// a v2 cache's lastScannedBlock is already advanced past EARLIEST_DEPLOY_BLOCK, so without a full
// rescan this running total would silently start from 0 and only ever count *future* sales,
// permanently missing every SubnameRegistered/ListingSold that happened before this change shipped.
// v4: added sellerAmountWei on individual subname_registered/listing_sold events (previously only
// folded into the running totalSellerRevenueWei total, never kept per-event) — powers the
// dashboard's daily seller-revenue bar chart. Same rescan requirement as v3, for the same reason:
// an event pushed before this change has no sellerAmountWei field, so the dashboard's per-day sum
// would silently treat every pre-upgrade sale as $0 revenue without a full rescan.
// v5: MARKETPLACE_ADDRESS switched from V3 to V4 (a fresh contract) and legacy V3 scanning was
// added alongside it — forced a full rescan so totalSellerRevenueWei and the event history are
// rebuilt from both contracts together.
// v6: MARKETPLACE_ADDRESS moved from V4 to V5, and legacy scanning generalized from one contract
// to a list (LEGACY_MARKETPLACES below, now V4 + V3) with per-address cursors — every source
// (marketplace, legacy marketplaces, BaseRegistrar) now gets its own independent cursor instead of
// marketplace/BaseRegistrar sharing one and legacy having a second — bumped for the same "force a
// clean rebuild rather than trust a differently-shaped cache" reasoning as v5, and every future
// redeploy.
// v7: MARKETPLACE_ADDRESS moved from V5 to V6 (a SECURITY FIX redeploy, see that constant's own
// comment) and V5 joined LEGACY_MARKETPLACES — same "differently-shaped cache" reasoning as v6.
const CACHE_SCHEMA_VERSION = 7;
// Was 5 minutes — bumped to 15 as part of cutting this backend's overall RPC volume across the
// board (see rpcProvider.js), same reasoning as every other cache/watcher's own interval bump.
const CACHE_INTERVAL_MS = process.env.NAME_SERVICE_STATS_CACHE_INTERVAL_MS
  ? parseInt(process.env.NAME_SERVICE_STATS_CACHE_INTERVAL_MS, 10)
  : 900000;
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
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, address indexed paymentToken, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
// V3's SubnameRegistered has no paymentToken (V3 predates multi-currency pricing) — everything
// else is identical to MARKETPLACE_ABI above, so decoding V3's raw logs with the newer signature
// (an extra indexed topic V3 logs don't have) would fail/misdecode. nextListingId/listings ARE
// still needed here — a V3 listing never sold/cancelled is still real and still buyable (see
// useMarketplaceListings.js), so the live listings snapshot below reads every marketplace source.
const LEGACY_V3_ABI = [
  "event NameRegistered(address indexed buyer, string label, uint256 basePrice, uint256 brokerageFee, address wrappedTo, uint16 fuses)",
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];

// Every deprecated marketplace this app used to point at, most-recent first — a domain/subname
// sale on any of them is real lifetime activity that shouldn't vanish from "Total Domain Revenue"/
// the trend chart just because MARKETPLACE_ADDRESS now points at a fresh contract. Each scanned on
// its own cursor (see scanAndPublish's own `sources`) since each has a different deploy block.
const LEGACY_MARKETPLACES = [
  { address: process.env.LEGACY_MARKETPLACE_V5_ADDRESS || "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7", deployBlock: 15874925, abi: MARKETPLACE_ABI },
  { address: process.env.LEGACY_MARKETPLACE_V4_ADDRESS || "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2", deployBlock: 15873016, abi: MARKETPLACE_ABI },
  { address: process.env.LEGACY_MARKETPLACE_V3_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13", deployBlock: 15207471, abi: LEGACY_V3_ABI },
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

async function scanAndPublish(marketplace, legacyContracts, baseRegistrar, provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getNameServiceStatsCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const events = Array.isArray(cached?.events) ? cached.events.slice() : [];
    // Lifetime sum of sellerAmount (the contract's own emitted 80% cut — see SELLER_BPS in
    // PlanetZephyrosSubdomainServiceV5.sol, not something this cache recomputes itself) across
    // every SubnameRegistered and ListingSold ever seen, on the current contract OR any deprecated
    // one (LEGACY_MARKETPLACES). Deliberately a running total seeded from the cache, NOT derived by
    // summing the `events` array above — that array is trimmed to MAX_HISTORY_EVENTS (oldest
    // dropped first), which would silently undercount a lifetime total once the ecosystem has more
    // sales than that cap. Mirrors the Marketplace contract's own totalCoreBurned pattern (a
    // running counter, not replayed from history each time) — see useBurnPool.js's
    // getTotalCoreBurned for the on-chain equivalent of this same idea.
    let totalSellerRevenueWei = BigInt(cached?.totalSellerRevenueWei || "0");

    const latestBlock = await marketplace.runner.getBlockNumber();
    const lastScannedBlocks = { ...(cached?.lastScannedBlocks || {}) };

    // Every source this cache has ever scanned — the current marketplace, every deprecated
    // marketplace, and BaseRegistrar (network-wide registrations) — each with its own deploy block
    // and own independent cursor, rather than any of them sharing one.
    const marketplaceSources = [
      { address: MARKETPLACE_ADDRESS, deployBlock: MARKETPLACE_DEPLOY_BLOCK, contract: marketplace },
      ...LEGACY_MARKETPLACES.map((m, i) => ({ address: m.address, deployBlock: m.deployBlock, contract: legacyContracts[i] })),
    ];
    const sources = [
      ...marketplaceSources,
      { address: BASE_REGISTRAR_ADDRESS, deployBlock: BASE_REGISTRAR_DEPLOY_BLOCK, contract: baseRegistrar },
    ];

    const ranges = sources.map(({ address, deployBlock }) => {
      const fromBlock = lastScannedBlocks[address] ? lastScannedBlocks[address] + 1 : deployBlock;
      const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_CYCLE - 1, latestBlock);
      return { fromBlock, toBlock };
    });

    if (sources.some((_, i) => ranges[i].fromBlock <= latestBlock)) {
      const perMarketplaceEvents = await Promise.all(
        marketplaceSources.map(({ contract }, i) => {
          const { fromBlock, toBlock } = ranges[i];
          if (fromBlock > latestBlock) return Promise.resolve([[], [], [], []]);
          return Promise.all([
            queryLogsChunked(contract, contract.filters.NameRegistered(), fromBlock, toBlock),
            queryLogsChunked(contract, contract.filters.DomainActivated(), fromBlock, toBlock),
            queryLogsChunked(contract, contract.filters.SubnameRegistered(), fromBlock, toBlock),
            queryLogsChunked(contract, contract.filters.ListingSold(), fromBlock, toBlock),
          ]);
        })
      );
      const baseRegistrarRange = ranges[ranges.length - 1];
      const networkRegistered = baseRegistrarRange.fromBlock <= latestBlock
        ? await queryLogsChunked(baseRegistrar, baseRegistrar.filters.NameRegistered(), baseRegistrarRange.fromBlock, baseRegistrarRange.toBlock)
        : [];

      const allEvents = [
        ...perMarketplaceEvents.flatMap(([registered, activated, subnamesReg, sold]) => [...registered, ...activated, ...subnamesReg, ...sold]),
        ...networkRegistered,
      ].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

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
            // event.args.paymentToken (V4) is ignored here — totalSellerRevenueWei assumes every
            // amount is ETN/18-decimals. Fine while no ERC20 payment token is whitelisted (Phase
            // 1), but once one is, an ERC20-paid sale would get summed in as if it were ETN.
            events.push({ type: "subname_registered", label: event.args.label, priceWei: event.args.price.toString(), sellerAmountWei: event.args.sellerAmount.toString(), timestampMs });
            totalSellerRevenueWei += event.args.sellerAmount;
          } else if (event.eventName === "ListingSold") {
            // txHash included so the frontend can link each sale straight to the block explorer —
            // no name/label available here either (ListingSold carries a listingId, not a label;
            // resolving one would mean an extra per-sale contract call this cache doesn't
            // otherwise need), so the link is the primary way to see what actually sold.
            events.push({ type: "listing_sold", priceWei: event.args.price.toString(), sellerAmountWei: event.args.sellerAmount.toString(), timestampMs, txHash: event.transactionHash });
            totalSellerRevenueWei += event.args.sellerAmount;
          }
        }
      }
    } else {
      console.log("📡 Name Service stats: all known sources caught up, refreshing live listings snapshot only");
    }

    // Trim to the most recent MAX_HISTORY_EVENTS — oldest drop off first.
    const trimmedEvents = events.length > MAX_HISTORY_EVENTS ? events.slice(events.length - MAX_HISTORY_EVENTS) : events;

    // Floor price / active listing count — a live read (same nextListingId/listings() pattern
    // marketplaceSellersCache.js uses), not derived from the event log above. Reconstructing
    // "currently active" from ExistingNameListed/ListingSold/ListingCancelled events would be
    // fragile (reorg edge cases, event-processing-order bugs); reading the contract's own current
    // state directly is what the site's live Marketplace page already trusts.
    // Merged across every marketplace source — same reasoning as useMarketplaceListings.js's
    // getActiveListings() on the frontend: a listing on a deprecated contract never
    // sold/cancelled is still real and still buyable, so "Active Listings"/"Floor Price" would
    // undercount and could show a stale, no-longer-lowest price if any were left out.
    async function readActiveListings(contract) {
      const nextId = await contract.nextListingId();
      const count = Number(nextId) - 1;
      if (count <= 0) return [];
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const raw = await mapWithConcurrency(ids, TIMESTAMP_CONCURRENCY, (id) => contract.listings(id));
      return raw.filter((l) => l.active);
    }

    let floorPriceWei = null;
    let activeListingsCount = 0;
    try {
      const perSourceActive = await Promise.all(marketplaceSources.map(({ contract }) => readActiveListings(contract)));
      const active = perSourceActive.flat();
      activeListingsCount = active.length;
      if (active.length > 0) {
        floorPriceWei = active.reduce((min, l) => (l.price < min ? l.price : min), active[0].price).toString();
      }
    } catch (err) {
      console.warn("⚠️  Name Service stats: failed to read live listings snapshot:", err.message);
    }

    sources.forEach(({ address }, i) => { lastScannedBlocks[address] = ranges[i].toBlock; });
    await setNameServiceStatsCache({
      events: trimmedEvents,
      floorPriceWei,
      activeListingsCount,
      totalSellerRevenueWei: totalSellerRevenueWei.toString(),
      lastScannedBlocks,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    const perSourceLog = sources.map(({ address }, i) => `${address.slice(0, 8)}…→${ranges[i].toBlock}`).join(", ");
    console.log(`📡 Name Service stats cache updated — ${trimmedEvents.length} event(s) tracked, ${activeListingsCount} active listing(s), ${ethers.formatEther(totalSellerRevenueWei)} ETN lifetime seller revenue (all known marketplaces), scanned: ${perSourceLog}`);
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
  const legacyContracts = LEGACY_MARKETPLACES.map((m) => new ethers.Contract(m.address, m.abi, provider));
  const baseRegistrar = new ethers.Contract(BASE_REGISTRAR_ADDRESS, BASE_REGISTRAR_ABI, provider);

  console.log(`📡 Name Service stats cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(marketplace, legacyContracts, baseRegistrar, provider);
  setInterval(() => scanAndPublish(marketplace, legacyContracts, baseRegistrar, provider), CACHE_INTERVAL_MS);
}
