import { ethers } from "ethers";
import { getSubnameDomainsCache, setSubnameDomainsCache } from "../state/subnameDomainsState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Keeps a small public JSON cache of "domains currently selling subnames" fresh in R2, so the
// frontend's SubnameSearch screen can fetch it with one plain HTTPS request instead of scanning
// SubnamePricePerYearSet events all the way back to MARKETPLACE_DEPLOY_BLOCK on every single page
// load (confirmed: ~111k blocks -> ~112 sequential chunked eth_getLogs round trips as of writing,
// and it only grows — every day adds another ~17k blocks/~17 round trips to that scan, forever,
// for every visitor). Same chain/contract defaults as marketplaceWatcher.js, overridable via env
// for a different deployment.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15874925;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Deliberately coarser than WATCHER_POLL_INTERVAL_MS (60s) — subname pricing changes far less
// often than domain activations/registrations, and after the first run this only ever scans the
// handful of blocks since lastScannedBlock, so there's little to gain from polling as tightly.
// Was 5 minutes — bumped to 15 as part of cutting this backend's overall RPC volume across the
// board (see rpcProvider.js), same reasoning as every other cache/watcher's own interval bump.
const CACHE_INTERVAL_MS = process.env.SUBNAME_DOMAINS_CACHE_INTERVAL_MS
  ? parseInt(process.env.SUBNAME_DOMAINS_CACHE_INTERVAL_MS, 10)
  : 900000;

// v2: bumped once, deliberately, to force every deployed instance's next tick to do a full fresh
// rescan from MARKETPLACE_DEPLOY_BLOCK instead of trusting a previously-published cache's
// lastScannedBlock — the chunked scan had a bug (see queryLogsChunked below) that could silently
// drop a domain's events, so a cache published before this fix may already be missing entries
// (confirmed: community.etn) that scanning forward from its lastScannedBlock would never revisit.
// v3: MARKETPLACE_ADDRESS moved from V4 to V5 (a fresh contract, lower block number than the old
// cache's already-advanced lastScannedBlock) — without a bump, the stale cursor would read as
// "already past V5's own deploy block", so this would silently stop finding ANY of V5's real
// SubnamePricePerYearSet events instead of rescanning from V5's actual start.
// v4: each domain entry's shape changed from a single `pricePerYear` (ETN-only, the event filter
// used to hard-code paymentToken === address(0)) to `pricesByCurrency` (a map of every currency
// the domain is actually priced in) — a v3 cache's entries are the old shape and would break every
// consumer expecting the new one, so this forces a clean rebuild rather than trying to migrate the
// shape in place. Not meant to be bumped routinely — only when a past scan's correctness or shape
// is actually in question, same as v2/v3.
const CACHE_SCHEMA_VERSION = 4;

const MARKETPLACE_ABI = [
  "event SubnamePricePerYearSet(bytes32 indexed parentNode, address indexed paymentToken, uint256 pricePerYear)",
  "function whitelistedPaymentTokens(address) view returns (bool)",
];
// Same minimal signature as marketplaceWatcher.js's own copy.
const NAME_WRAPPER_ABI = ["function names(bytes32 node) view returns (bytes)"];

function decodeFirstLabel(hex) {
  const bytes = ethers.getBytes(hex);
  if (bytes.length < 1) return null;
  const len = bytes[0];
  if (bytes.length < 1 + len) return null;
  return ethers.toUtf8String(bytes.slice(1, 1 + len));
}

const MIN_CHUNK_SIZE = 50;
// A "Block range is too large" rejection on an already-tiny range isn't really about size —
// confirmed live: Ankr's public RPC returned exactly this error (code -32062) for a 25-block
// range, which can't genuinely be "too large". Reads as transient rate-limiting mislabeled with a
// range-flavored message rather than a real "give a smaller range" signal. Since scanAndPublish
// below only persists progress once the *entire* multi-chunk scan succeeds, one chunk that keeps
// failing at the floor size — with no backoff — used to fail the whole scan and force every
// following tick to restart the full range from scratch, repeatedly, rather than just clearing on
// its own after a moment like a rate limit normally would.
const MAX_FLOOR_RETRIES = 6;
const FLOOR_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same range-adaptive chunking as marketplaceWatcher.js's queryLogsChunked, plus running chunks
// concurrently (bounded) instead of one at a time — duplicated rather than shared for the same
// "fine to drift independently" reasoning marketplaceWatcher.js already gives for its own copy.
// Concurrency is safe for the fold in scanAndPublish below because results are reassembled in
// chunk (= block) order before being applied, regardless of which chunk's request finishes first.
//
// Each worker's inner loop must fully WALK its assigned [rangeStart, rangeEnd] — advancing a
// cursor after every successful sub-fetch and only shrinking the sub-fetch size (never `end`) on a
// range-rejection. An earlier version shrunk `end` on rejection and broke out after the first
// (now-smaller) fetch succeeded, silently discarding whatever blocks that left uncovered between
// the shrunk end and the original one — confirmed live: community.etn's SubnamePricePerYearSet
// events went missing from the published cache this way, since they happened to sit past a
// rejected chunk's shrink point. Fixed by tracking cursor/rangeEnd separately from the sub-fetch
// size, so a shrink retries forward from where it left off instead of abandoning the remainder.
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
          floorRetries = 0; // reset backoff once any fetch succeeds
        } catch (err) {
          const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
          const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
          if (!isRangeError) throw err;

          if (size > MIN_CHUNK_SIZE) {
            size = Math.max(MIN_CHUNK_SIZE, Math.floor(size / 2));
            continue; // retry the same `cursor` with the smaller window
          }

          // Already at the floor and still rejected — back off and retry in place instead of
          // giving up (see MAX_FLOOR_RETRIES comment above).
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

let isRunning = false;

async function scanAndPublish(provider, marketplace, nameWrapper) {
  if (isRunning) return; // previous run still in flight (e.g. a slow cold-start scan) — skip this tick
  isRunning = true;
  try {
    const rawCache = await getSubnameDomainsCache();
    // Discard anything published under an older schema version — see CACHE_SCHEMA_VERSION above.
    const cached = rawCache?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCache : null;
    // node -> { label, pricesByCurrency: { [tokenAddress]: pricePerYearString } } — carried
    // forward from the previous publish so an already-known domain/currency isn't lost, only
    // ever updated by a newer event for that same (node, currency) pair.
    const domainByNode = new Map(
      (cached?.domains || []).map((d) => [d.node, { label: d.label, pricesByCurrency: { ...d.pricesByCurrency } }])
    );
    const fromBlock = cached?.lastScannedBlock ? cached.lastScannedBlock + 1 : MARKETPLACE_DEPLOY_BLOCK;

    const latestBlock = await provider.getBlockNumber();
    if (fromBlock > latestBlock) return; // already caught up

    // No paymentToken filter — unlike the ETN-only Phase 1 version of this cache, every
    // currency's price-set events are scanned, so a domain can be published as for-sale in
    // several currencies at once (exactly what setSubnamePricePerYear itself allows on-chain).
    const events = await queryLogsChunked(
      marketplace,
      marketplace.filters.SubnamePricePerYearSet(),
      fromBlock,
      latestBlock
    );
    // Ascending (block, logIndex) order so "latest price wins" folds correctly per (node,
    // currency) pair, regardless of which chunk's request happened to finish first.
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

    for (const event of events) {
      const { parentNode, paymentToken, pricePerYear } = event.args;

      if (pricePerYear === 0n) {
        // Only this ONE currency was turned off — a domain still for sale in any other currency
        // stays published; the domain entry itself is only dropped later, once (and if) it has
        // no currencies left at all.
        delete domainByNode.get(parentNode)?.pricesByCurrency?.[paymentToken];
        continue;
      }

      let domain = domainByNode.get(parentNode);
      if (!domain) {
        let label;
        try {
          label = decodeFirstLabel(await nameWrapper.names(parentNode));
        } catch (err) {
          console.error(`⚠️  Failed to decode label for ${parentNode}:`, err.message);
          continue; // don't publish a domain we can't show a name for
        }
        if (!label) continue;
        domain = { label, pricesByCurrency: {} };
        domainByNode.set(parentNode, domain);
      }

      domain.pricesByCurrency[paymentToken] = pricePerYear.toString();
    }

    // Live-verify every non-ETN currency still whitelisted — a token the owner has since
    // de-whitelisted would otherwise keep showing here with a stale price that reverts
    // ("Token not whitelisted") the moment a buyer actually tries to register in it. ETN
    // (address(0)) is always implicitly valid and never appears in this mapping, so it's the
    // only currency skipped here rather than checked.
    const allTokens = new Set();
    for (const domain of domainByNode.values()) {
      for (const token of Object.keys(domain.pricesByCurrency)) {
        if (token !== ethers.ZeroAddress) allTokens.add(token);
      }
    }
    const whitelistedByToken = new Map();
    await Promise.all([...allTokens].map(async (token) => {
      try {
        whitelistedByToken.set(token, await marketplace.whitelistedPaymentTokens(token));
      } catch (err) {
        console.warn(`⚠️  Couldn't verify whitelist status for ${token}, excluding it to be safe:`, err.message);
        whitelistedByToken.set(token, false);
      }
    }));

    for (const [node, domain] of [...domainByNode.entries()]) {
      for (const token of Object.keys(domain.pricesByCurrency)) {
        if (token !== ethers.ZeroAddress && !whitelistedByToken.get(token)) {
          delete domain.pricesByCurrency[token];
        }
      }
      // A domain that's ended up with no currencies left at all (every one turned off, or every
      // ERC20 it was priced in has since been de-whitelisted, and it was never priced in ETN)
      // isn't for sale in anything — drop it entirely rather than publish an empty listing.
      if (Object.keys(domain.pricesByCurrency).length === 0) domainByNode.delete(node);
    }

    const domains = [...domainByNode.entries()].map(([node, domain]) => ({ node, ...domain }));
    await setSubnameDomainsCache(domains, latestBlock, CACHE_SCHEMA_VERSION);
    console.log(`📡 Subname domains cache updated — ${domains.length} domain(s) selling subnames, scanned to block ${latestBlock}`);
  } catch (err) {
    console.error("⚠️  Subname domains cache scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured — there'd be nowhere public
 * to publish to, and nothing for the frontend to fetch, so it's not worth running at all (unlike
 * the Telegram watcher, this has no other job to do).
 */
export function startSubnameDomainsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — subname domains cache disabled (frontend will fall back to scanning on-chain directly)");
    return;
  }

  const provider = createRpcProvider();
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  console.log(`📡 Subname domains cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(provider, marketplace, nameWrapper); // run once immediately rather than waiting a full interval
  setInterval(() => scanAndPublish(provider, marketplace, nameWrapper), CACHE_INTERVAL_MS);
}
