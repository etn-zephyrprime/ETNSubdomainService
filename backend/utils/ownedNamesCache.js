import { ethers } from "ethers";
import { getOwnedNamesCache, setOwnedNamesCache } from "../state/ownedNamesState.js";

// Keeps a small public JSON cache of every *wrapped* name (top-level domain or subname) in R2 —
// node, current owner, expiry, whether it's a subname (and if so its parent), and whether a
// top-level domain has activated subname-selling — for "Manage & Resell" and "Register Subdomain"
// to list a connected wallet's own names instead of making them type one in to look it up. Same
// reasoning as activatedDomainsCache.js: resolving this per-name in the browser for a whole
// wallet's holdings would be the same RPC-flood/batch-rejection problem fixed there and in
// marketplaceSellersCache.js.
//
// NOT included: unwrapped names (registered directly through Electroneum, outside this app,
// never wrapped into NameWrapper) — there's no event this app can observe that carries their
// plaintext label, only the raw BaseRegistrar tokenId (a hash). The only way to identify one is
// still the owner typing its name in, which is exactly why "Register Subdomain"'s manual-lookup
// fallback exists alongside this list rather than being replaced by it.
//
// Three event sources, since a wrapped name can reach that state three different ways:
//   - NameRegistered (Marketplace): a brand-new top-level name registered through this app —
//     carries the plaintext label directly, and is wrapped immediately (registerName always
//     wraps) but not necessarily activated yet.
//   - DomainActivated (Marketplace): a top-level domain (freshly registered above, or a
//     previously-unwrapped "retro" name) activates subname-selling — this is also the moment a
//     retro name gets wrapped for the first time, so it's the only way this cache ever learns
//     about one (via NameWrapper.names(node), decodable only once wrapped).
//   - SubnameRegistered (Marketplace): a subname, always wrapped at creation, label given
//     directly by the event.
//
// Same cold-start-safe design as activatedDomainsCache.js from the start this time (see that
// file's history for why): bounded per-cycle block range, checkpointed after every cycle, and
// owner/expiry re-verified for every previously-known node every cycle (a direct NameWrapper
// transfer never touches the Marketplace contract, so no event here would ever reflect it) — but
// "activated" status is trusted from DomainActivated alone, not re-checked live, since activation
// only ever happens through that one event and never reverts once set.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15207471;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same value as src/config.js's ETN_NODE — namehash("etn") — needed to derive a top-level node
// from NameRegistered's plaintext label the same way computeNode() does client-side.
const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";
const CACHE_INTERVAL_MS = process.env.OWNED_NAMES_CACHE_INTERVAL_MS
  ? parseInt(process.env.OWNED_NAMES_CACHE_INTERVAL_MS, 10)
  : 300000;
const MAX_BLOCKS_PER_CYCLE = process.env.OWNED_NAMES_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.OWNED_NAMES_MAX_BLOCKS_PER_CYCLE, 10)
  : 50000;
const CACHE_SCHEMA_VERSION = 1;
const VERIFY_CONCURRENCY = 8;

const MARKETPLACE_ABI = [
  "event NameRegistered(address indexed buyer, string label, uint256 basePrice, uint256 brokerageFee, address wrappedTo, uint16 fuses)",
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
];
const NAME_WRAPPER_ABI = [
  "function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)",
  "function names(bytes32 node) view returns (bytes)",
];

function computeNode(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([ETN_NODE, labelHash]));
}

function computeSubnode(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

const MIN_CHUNK_SIZE = 50;
const MAX_FLOOR_RETRIES = 6;
const FLOOR_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same range-adaptive chunked/concurrent log scan as this repo's other caches — see
// subnameDomainsCache.js's comment for the full reasoning. Duplicated rather than shared, same
// "fine to drift independently" philosophy already established for the other copies.
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

async function readCurrentData(nameWrapper, node) {
  try {
    const data = await nameWrapper.getData(node);
    return { owner: data.owner.toLowerCase(), expiry: Number(data.expiry) };
  } catch (err) {
    console.warn(`⚠️  getData(${node}) failed, dropping this entry:`, err.message);
    return null;
  }
}

let isRunning = false;

async function scanAndPublish(marketplace, nameWrapper) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCache = await getOwnedNamesCache();
    const cached = rawCache?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCache : null;

    // node -> { name, isSubname, parentNode, activated }
    const nodes = new Map(
      (cached?.names || []).map((n) => [
        n.node,
        { name: n.name, isSubname: n.isSubname, parentNode: n.parentNode || null, activated: n.activated ?? null },
      ])
    );

    const fromBlock = cached?.lastScannedBlock ? cached.lastScannedBlock + 1 : MARKETPLACE_DEPLOY_BLOCK;
    const latestBlock = await marketplace.runner.getBlockNumber();
    const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_CYCLE - 1, latestBlock);
    const blocksRemainingAfterThisCycle = latestBlock - toBlock;

    if (fromBlock <= latestBlock) {
      const [registeredEvents, activatedEvents, subnameEvents] = await Promise.all([
        queryLogsChunked(marketplace, marketplace.filters.NameRegistered(), fromBlock, toBlock),
        queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), fromBlock, toBlock),
        queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), fromBlock, toBlock),
      ]);

      const allEvents = [...registeredEvents, ...activatedEvents, ...subnameEvents].sort(
        (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
      );

      for (const event of allEvents) {
        if (event.eventName === "NameRegistered") {
          const { label } = event.args;
          const node = computeNode(label);
          if (!nodes.has(node)) {
            nodes.set(node, { name: label, isSubname: false, parentNode: null, activated: false });
          }
        } else if (event.eventName === "DomainActivated") {
          const { node } = event.args;
          const existing = nodes.get(node);
          if (existing) {
            existing.activated = true;
          } else {
            // A "retro" name — wrapped for the first time by this very activation, so this is the
            // only point its label ever becomes decodable. Deferred to the verification pass
            // below (needs a contract call), tracked here as a placeholder so it's not lost.
            nodes.set(node, { name: null, isSubname: false, parentNode: null, activated: true });
          }
        } else if (event.eventName === "SubnameRegistered") {
          const { parentNode, label } = event.args;
          const subNode = computeSubnode(parentNode, label);
          if (!nodes.has(subNode)) {
            nodes.set(subNode, { name: label, isSubname: true, parentNode, activated: null });
          }
        }
      }
    } else {
      console.log("📡 Owned names cache: already caught up, re-verifying known entries only");
    }

    // Decode labels for any "retro" domains discovered only via DomainActivated above (name still
    // null) — now wrapped, so NameWrapper.names(node) finally has an entry for them.
    const needsLabel = [...nodes.entries()].filter(([, n]) => n.name === null && !n.isSubname);
    if (needsLabel.length > 0) {
      await mapWithConcurrency(needsLabel, VERIFY_CONCURRENCY, async ([node, entry]) => {
        try {
          const encoded = await nameWrapper.names(node);
          const bytes = ethers.getBytes(encoded);
          const len = bytes[0];
          entry.name = len > 0 && bytes.length >= 1 + len ? ethers.toUtf8String(bytes.slice(1, 1 + len)) : null;
        } catch (err) {
          console.warn(`⚠️  Failed to decode label for retro-activated domain ${node}:`, err.message);
        }
      });
    }

    // Re-verify current owner + expiry for every known node — see file header for why this can't
    // just trust the previous cycle's values (a direct NameWrapper transfer never touches the
    // Marketplace contract).
    const entries = [...nodes.entries()];
    await mapWithConcurrency(entries, VERIFY_CONCURRENCY, async ([node, entry]) => {
      entry.current = await readCurrentData(nameWrapper, node);
    });

    const names = [];
    for (const [node, entry] of entries) {
      if (!entry.current || !entry.name) continue; // gone (getData reverted) or label still unresolved
      names.push({
        node,
        name: entry.isSubname ? `${entry.name}.${resolveParentName(nodes, entry.parentNode)}.etn` : `${entry.name}.etn`,
        owner: entry.current.owner,
        expiry: entry.current.expiry,
        isSubname: entry.isSubname,
        parentNode: entry.parentNode,
        activated: entry.isSubname ? null : entry.activated,
      });
    }

    await setOwnedNamesCache(names, toBlock, CACHE_SCHEMA_VERSION);

    const backlogNote = blocksRemainingAfterThisCycle > 0
      ? ` (${blocksRemainingAfterThisCycle} block(s) of backlog left — continues next cycle)`
      : "";
    console.log(`📡 Owned names cache updated — ${names.length} name(s), scanned to block ${toBlock}${backlogNote}`);
  } catch (err) {
    console.error("⚠️  Owned names cache scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

// A subname's display name needs its parent's label, which might itself still be an unresolved
// "retro" placeholder in the same pass (rare: would need a subname registered in the very same
// cycle its own parent was first activated) — falls back to "(unknown)" rather than a raw node.
function resolveParentName(nodes, parentNode) {
  const parent = nodes.get(parentNode);
  return parent?.name || "(unknown)";
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startOwnedNamesCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — owned names cache disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as activatedDomainsCache.js/marketplaceSellersCache.js, applied
  // from the start this time rather than as a follow-up fix.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  console.log(`📡 Owned names cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(marketplace, nameWrapper);
  setInterval(() => scanAndPublish(marketplace, nameWrapper), CACHE_INTERVAL_MS);
}
