import { ethers } from "ethers";
import { getActivatedDomainsCache, setActivatedDomainsCache } from "../state/activatedDomainsState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Keeps a small public JSON cache of every activated domain (and the subnames registered under
// each) fresh in R2, for the homepage's "Activated Domains" table — same reasoning as
// subnameDomainsCache.js: scanning DomainActivated/SubnameRegistered all the way back to
// MARKETPLACE_DEPLOY_BLOCK, then resolving owner + expiry + primary name for every result, is far
// too much for a visitor's browser to do on every page load. Scanned server-side on a timer
// instead; the frontend does one plain fetch.
//
// Unlike subnameDomainsCache.js, this doesn't just append new events and trust old entries stay
// correct — ownership can change via a direct NameWrapper transfer that never goes through the
// Marketplace contract at all (so no event this scan listens for would ever fire), and expiry
// ticks down continuously regardless of any event. So every scan cycle re-reads
// NameWrapper.getData() for every *previously known* domain/subname too, not just newly
// discovered ones — event scanning is only used to discover which nodes exist, not as the source
// of truth for their current owner/expiry. This is the dominant RPC cost here and the main thing
// to revisit (e.g. re-verify on a slower rotating schedule instead of every entry every cycle) if
// the number of activated domains grows large enough for it to matter.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15874925;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS — needed here to resolve each owner's
// primary name server-side instead of per-listing in the browser (see useReverseRecord.js, which
// this mirrors the read side of).
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
// Was 5 minutes — bumped to 15 as part of cutting this backend's overall RPC volume (see
// rpcProvider.js): this cache re-verifies owner/expiry for *every* known domain and subname on
// *every* cycle (see the header comment above), which made it one of the largest steady-state RPC
// consumers here even though its own event-scanning is cheap. Frontend now carries a note near
// the Activated Domains table (src/components/ActivatedDomainsTable.jsx) explaining a
// just-activated domain can take up to 15 minutes to show up.
const CACHE_INTERVAL_MS = process.env.ACTIVATED_DOMAINS_CACHE_INTERVAL_MS
  ? parseInt(process.env.ACTIVATED_DOMAINS_CACHE_INTERVAL_MS, 10)
  : 900000;
// Caps how many blocks of event history a single cycle scans, rather than always racing straight
// to the current chain tip. On a cold cache (fresh deploy, or R2 wiped) that gap is the entire
// history back to MARKETPLACE_DEPLOY_BLOCK — ~300k blocks as of writing — and this cache does far
// more per result (getData() + primary-name resolution for every domain *and* subname) than
// subnameDomainsCache.js. Scanning + verifying all of that in one pass before publishing anything
// was the actual bug behind "Couldn't load activated domains" never going away: nothing gets
// checkpointed until setActivatedDomainsCache() at the very end, so a single rate-limit hiccup
// anywhere in that whole pass discarded ALL progress, and the next cycle started over from
// MARKETPLACE_DEPLOY_BLOCK again — a cache that could fail to ever complete its first publish.
// Bounding each cycle's range means a large backlog is consumed gradually across several cycles
// instead, with real (if partial) progress checkpointed and published after every one of them.
const MAX_BLOCKS_PER_CYCLE = process.env.ACTIVATED_DOMAINS_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.ACTIVATED_DOMAINS_MAX_BLOCKS_PER_CYCLE, 10)
  : 50000;
// v2: added legacy V3 scanning alongside V4 — forced a full rebuild from both contracts.
// v3: MARKETPLACE_ADDRESS moved from V4 to V5, and legacy scanning generalized from one contract
// to a list (MARKETPLACE_SOURCES below, now V4 + V3) with per-address cursors instead of a single
// legacyLastScannedBlock — bumped for the same "force a clean rebuild rather than trust a
// differently-shaped cache" reasoning as v2, and every future redeploy, same reasoning
// nameServiceStatsCache.js's own version bumps give.
// v4: added each domain's own `activatedOn` version tag (below) — a domain whose DomainActivated
// event lives on a legacy contract and hasn't migrated forward yet still needs to show up here
// (see this file's own header comment on why it's included at all), but the frontend needs to know
// which contract it's actually paid-up-and-live on to tag it correctly rather than imply it's
// current-V5. Bumped for the same "differently-shaped cache" reasoning as v2/v3.
const CACHE_SCHEMA_VERSION = 4;

// Human-readable version label for each entry in `sources` below, matched by array position —
// index 0 (MARKETPLACE_ADDRESS) is always the current contract, "V5"; LEGACY_MARKETPLACES then
// follows in the same V4-then-V3 order every other consumer of that list already assumes (see
// src/config.js's own LEGACY_MARKETPLACES comment).
const SOURCE_VERSION_LABELS = ["V5", "V4", "V3"];

// How many getData()/primary-name lookups run at once during the re-verification pass — bounded
// the same way queryLogsChunked below bounds its own concurrency, so a growing domain count
// degrades to "this cycle takes longer" rather than "the RPC gets hammered all at once".
const VERIFY_CONCURRENCY = 8;

// V4/V5 share this event shape exactly. V3's SubnameRegistered has no paymentToken (V3 predates
// multi-currency pricing) — DomainActivated is identical everywhere. domainActivated() (the plain
// public mapping getter) is only ever called against the CURRENT contract (see scanAndPublish's
// migration re-check) but declared here rather than a separate ABI since MARKETPLACE_ABI is
// already shared with the V4 legacy contract, which has the exact same getter.
const MARKETPLACE_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, address indexed paymentToken, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function domainActivated(bytes32 node) view returns (bool)",
];
const LEGACY_V3_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
];

// Every deprecated marketplace this app used to point at, most-recent first — a domain activated
// (or a subname registered) on any of them is real lifetime activity that shouldn't vanish from
// "Activated Domains"/the dashboard's Name Service section just because MARKETPLACE_ADDRESS now
// points at a fresh contract with no memory of that history. Each scanned on its own cursor (see
// scanAndPublish's MARKETPLACE_SOURCES) since each has a different deploy block.
const LEGACY_MARKETPLACES = [
  { address: process.env.LEGACY_MARKETPLACE_V4_ADDRESS || "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2", deployBlock: 15873016, abi: MARKETPLACE_ABI },
  { address: process.env.LEGACY_MARKETPLACE_V3_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13", deployBlock: 15207471, abi: LEGACY_V3_ABI },
];

const NAME_WRAPPER_ABI = [
  "function names(bytes32 node) view returns (bytes)",
  "function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)",
];
const REVERSE_REGISTRAR_ABI = [
  "function node(address addr) view returns (bytes32)",
  "function defaultResolver() view returns (address)",
];
const RESOLVER_ABI = ["function name(bytes32 node) view returns (string)"];

function decodeFirstLabel(hex) {
  const bytes = ethers.getBytes(hex);
  if (bytes.length < 1) return null;
  const len = bytes[0];
  if (bytes.length < 1 + len) return null;
  return ethers.toUtf8String(bytes.slice(1, 1 + len));
}

// Same construction as marketplaceWatcher.js's computeSubnode — SubnameRegistered's event args
// give the parent's node + the child's own label, not the child's own node, and getData() needs
// the child's node (as a uint256 id) to look up its owner/expiry.
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

// Same range-adaptive chunked/concurrent log scan as subnameDomainsCache.js's own copy — see that
// file's comment for the full reasoning (transient range-rejections that aren't really about
// size, floor-retry backoff, etc.). Duplicated rather than shared for the same "fine to drift
// independently" reasoning already given for the other two copies of this in the codebase.
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

// Runs `fn` over `items` with at most `concurrency` in flight at once, same worker-pool shape as
// queryLogsChunked above — used for the getData()/primary-name re-verification passes, where each
// call is cheap individually but there can be many of them.
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

// Re-reads current owner + expiry for a single node. Returns null if getData() reverts (name was
// never wrapped, or has been burned/deleted) — signals the caller to drop this entry entirely
// rather than publish stale/wrong data.
async function readCurrentData(nameWrapper, node) {
  try {
    const data = await nameWrapper.getData(node);
    return { owner: data.owner.toLowerCase(), expiry: Number(data.expiry) };
  } catch (err) {
    console.warn(`⚠️  getData(${node}) failed, dropping this entry:`, err.message);
    return null;
  }
}

// Resolves an address's primary ("reverse") name, or null if none is set — same lookup
// useReverseRecord.js's getPrimaryName does, just run once per unique owner here instead of once
// per listing in every visitor's browser. Takes an already-resolved `resolver` contract rather
// than calling defaultResolver() itself — see scanAndPublish, where it's fetched once per cycle
// instead of once per owner (it's a single global value, not address-dependent; re-fetching it
// redundantly for every owner was half of what caused every primary name to fail to resolve, see
// this file's header comment for the full story).
async function resolvePrimaryName(reverseRegistrar, resolver, addr) {
  try {
    const node = await reverseRegistrar.node(addr);
    const name = await resolver.name(node);
    return name || null;
  } catch (err) {
    console.warn(`⚠️  Failed to resolve primary name for ${addr}:`, err.message);
    return null;
  }
}

let isRunning = false;

async function scanAndPublish(provider, marketplace, legacyContracts, nameWrapper, reverseRegistrar) {
  if (isRunning) return; // previous run still in flight — skip this tick
  isRunning = true;
  try {
    const rawCache = await getActivatedDomainsCache();
    const cached = rawCache?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCache : null;

    // node -> { label, subnames: Map(subNode -> { label }), activatedOn } — carried forward from
    // the previous publish so already-discovered domains/subnames aren't lost, only ever added to
    // by new events. activatedOn defaults to "V5" for any pre-v4-schema entry it might somehow see
    // (shouldn't happen — the schema-version check above already forces a full rebuild on v4's
    // first run — but a domain actually native to V5 needs this same default too, since its
    // DomainActivated event assigns activatedOn itself only at the point of first discovery below).
    const domainByNode = new Map(
      (cached?.domains || []).map((d) => [
        d.node,
        { label: d.label, subnames: new Map((d.subnames || []).map((s) => [s.node, { label: s.label }])), activatedOn: d.activatedOn || "V5" },
      ])
    );

    const latestBlock = await provider.getBlockNumber();
    const lastScannedBlocks = { ...(cached?.lastScannedBlocks || {}) };

    // Every marketplace this app has ever scanned — the current contract plus every deprecated
    // one (LEGACY_MARKETPLACES) — each with its own deploy block and own cursor (their whole
    // histories are already in the past relative to a fresh deploy, so each legacy source catches
    // up within a few cycles and then just finds nothing new on every poll after).
    const sources = [
      { address: MARKETPLACE_ADDRESS, deployBlock: MARKETPLACE_DEPLOY_BLOCK, contract: marketplace, versionLabel: SOURCE_VERSION_LABELS[0] },
      ...LEGACY_MARKETPLACES.map((m, i) => ({ address: m.address, deployBlock: m.deployBlock, contract: legacyContracts[i], versionLabel: SOURCE_VERSION_LABELS[i + 1] })),
    ];

    const ranges = sources.map(({ address, deployBlock }) => {
      const fromBlock = lastScannedBlocks[address] ? lastScannedBlocks[address] + 1 : deployBlock;
      // This cycle's target — the real chain tip, or less if there's more backlog than
      // MAX_BLOCKS_PER_CYCLE allows in one pass (see that constant's comment). Checkpointed below
      // instead of latestBlock, so a capped cycle correctly resumes from here next time rather
      // than either re-scanning what it just did or skipping ahead.
      const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_CYCLE - 1, latestBlock);
      return { fromBlock, toBlock };
    });
    const blocksRemainingAfterThisCycle = Math.max(...sources.map((_, i) => latestBlock - ranges[i].toBlock), 0);

    if (sources.some((_, i) => ranges[i].fromBlock <= latestBlock)) {
      const perSourceEvents = await Promise.all(
        sources.map(({ contract }, i) => {
          const { fromBlock, toBlock } = ranges[i];
          if (fromBlock > latestBlock) return Promise.resolve([[], []]);
          return Promise.all([
            queryLogsChunked(contract, contract.filters.DomainActivated(), fromBlock, toBlock),
            queryLogsChunked(contract, contract.filters.SubnameRegistered(), fromBlock, toBlock),
          ]);
        })
      );

      // Each event paired with which source found it — a domain's DomainActivated only ever fires
      // once, on whichever contract it was originally activated on (migrateActivation emits its
      // own ActivationMigrated instead, never a second DomainActivated), so this is a reliable,
      // one-time tag rather than something that needs picking "the right" event among duplicates.
      const allActivatedEvents = perSourceEvents.flatMap(([activated], i) =>
        activated.map((event) => ({ event, versionLabel: sources[i].versionLabel }))
      );
      const allSubnameEvents = perSourceEvents.flatMap(([, subnames]) => subnames);

      // Ascending order so processing reflects on-chain sequence, though it only matters here for
      // consistent logging — unlike subnameDomainsCache.js's price folding, discovery doesn't
      // depend on event order (a node's label/existence doesn't change after the fact).
      allActivatedEvents.sort((a, b) => a.event.blockNumber - b.event.blockNumber || a.event.index - b.event.index);
      allSubnameEvents.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      for (const { event, versionLabel } of allActivatedEvents) {
        const { node } = event.args;
        if (domainByNode.has(node)) continue;

        try {
          const label = decodeFirstLabel(await nameWrapper.names(node));
          if (!label) continue;
          domainByNode.set(node, { label, subnames: new Map(), activatedOn: versionLabel });
        } catch (err) {
          console.error(`⚠️  Failed to decode label for activated domain ${node}:`, err.message);
        }
      }

      for (const event of allSubnameEvents) {
        const { parentNode, label } = event.args;
        const domain = domainByNode.get(parentNode);
        // A subname of a domain we haven't seen DomainActivated for yet (shouldn't happen under
        // normal contract rules — you can't sell subnames on a domain that isn't activated — but
        // scanning in block order across two independent event streams could still race a fresh
        // one within the same tick). Skip; it'll attach correctly next cycle once the domain
        // itself has been discovered.
        if (!domain) continue;

        const subNode = computeSubnode(parentNode, label);
        if (!domain.subnames.has(subNode)) {
          domain.subnames.set(subNode, { label });
        }
      }
    } else {
      console.log("📡 Activated domains cache: all known marketplaces caught up, re-verifying known entries only");
    }

    // Re-verify current owner + expiry for every known node (domains and subnames alike) — see
    // file header for why this can't just trust the previous cycle's values. Flattened into one
    // list so the concurrency bound applies across all of them together, not per-domain.
    const allNodes = [];
    for (const [node, domain] of domainByNode.entries()) {
      allNodes.push({ node, target: domain, isDomain: true });
      for (const [subNode, sub] of domain.subnames.entries()) {
        allNodes.push({ node: subNode, target: sub, parentNode: node, isDomain: false });
      }
    }

    await mapWithConcurrency(allNodes, VERIFY_CONCURRENCY, async ({ node, target, isDomain }) => {
      target.current = await readCurrentData(nameWrapper, node);

      // A domain discovered via a legacy contract's own DomainActivated (activatedOn !== "V5")
      // might have been migrated forward since the last cycle (migrateActivation, run from
      // ManageSubdomain.jsx) — re-check the CURRENT contract's own domainActivated for it every
      // cycle and flip the tag to "V5" once that's true, so a migrated domain stops looking like
      // it's still stuck on the old one. Subnames have no activation/migration status of their own
      // (only their parent domain does), so this only ever runs for isDomain entries.
      if (isDomain && target.activatedOn && target.activatedOn !== "V5") {
        try {
          if (await marketplace.domainActivated(node)) target.activatedOn = "V5";
        } catch (err) {
          console.warn(`⚠️  domainActivated(${node}) migration check failed, keeping previous activatedOn tag:`, err.message);
        }
      }
    });

    // Drop anything getData() reverted on (see readCurrentData) — genuinely gone, not just expired.
    for (const [node, domain] of [...domainByNode.entries()]) {
      if (!domain.current) {
        domainByNode.delete(node);
        continue;
      }
      for (const [subNode, sub] of [...domain.subnames.entries()]) {
        if (!sub.current) domain.subnames.delete(subNode);
      }
    }

    // Resolve each unique current owner's primary name once, reused across every domain/subname
    // they own — a single active owner of many subnames only costs one reverse lookup, not one per
    // name.
    const uniqueOwners = new Set();
    for (const domain of domainByNode.values()) {
      uniqueOwners.add(domain.current.owner);
      for (const sub of domain.subnames.values()) uniqueOwners.add(sub.current.owner);
    }

    const primaryNameByOwner = new Map();
    const defaultResolverAddr = await reverseRegistrar.defaultResolver();

    if (defaultResolverAddr !== ethers.ZeroAddress) {
      const resolver = new ethers.Contract(defaultResolverAddr, RESOLVER_ABI, provider);
      await mapWithConcurrency([...uniqueOwners], VERIFY_CONCURRENCY, async (owner) => {
        primaryNameByOwner.set(owner, await resolvePrimaryName(reverseRegistrar, resolver, owner));
      });
    }

    const domains = [...domainByNode.entries()].map(([node, domain]) => ({
      node,
      label: domain.label,
      owner: domain.current.owner,
      ownerPrimaryName: primaryNameByOwner.get(domain.current.owner) || null,
      expiry: domain.current.expiry,
      activatedOn: domain.activatedOn,
      subnames: [...domain.subnames.entries()].map(([subNode, sub]) => ({
        node: subNode,
        label: sub.label,
        owner: sub.current.owner,
        ownerPrimaryName: primaryNameByOwner.get(sub.current.owner) || null,
        expiry: sub.current.expiry,
      })),
    }));

    sources.forEach(({ address }, i) => { lastScannedBlocks[address] = ranges[i].toBlock; });
    await setActivatedDomainsCache(domains, lastScannedBlocks, CACHE_SCHEMA_VERSION);

    const subnameCount = domains.reduce((sum, d) => sum + d.subnames.length, 0);
    const backlogNote = blocksRemainingAfterThisCycle > 0
      ? ` (${blocksRemainingAfterThisCycle} block(s) of backlog left — continues next cycle)`
      : "";
    const perSourceLog = sources.map(({ address }, i) => `${address.slice(0, 8)}…→${ranges[i].toBlock}`).join(", ");
    console.log(`📡 Activated domains cache updated — ${domains.length} domain(s), ${subnameCount} subname(s) (all known marketplaces), scanned: ${perSourceLog}${backlogNote}`);
  } catch (err) {
    console.error("⚠️  Activated domains cache scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as
 * subnameDomainsCache.js — there'd be nowhere public to publish to.
 */
export function startActivatedDomainsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — activated domains cache disabled");
    return;
  }

  // batchMaxCount: 1 — this file is the heaviest user of concurrent RPC calls of any cache here
  // (VERIFY_CONCURRENCY workers, each potentially chaining 2+ calls), and ethers' default behavior
  // coalesces concurrent calls fired in the same tick into a single JSON-RPC batch request. Ankr's
  // public endpoint rejects large batches outright (HTTP 413 "Batch size too large", code -32062)
  // — confirmed live, this is what silently broke every primary-name resolution (every owner
  // showed as a raw address, never a primary name, regardless of whether one was actually set).
  // Disabling batching sends each call as its own HTTP request instead — slightly more request
  // overhead, but each one succeeds or fails on its own rather than one oversized batch taking
  // every concurrent call down with it.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const legacyContracts = LEGACY_MARKETPLACES.map((m) => new ethers.Contract(m.address, m.abi, provider));
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
  const reverseRegistrar = new ethers.Contract(REVERSE_REGISTRAR_ADDRESS, REVERSE_REGISTRAR_ABI, provider);

  console.log(`📡 Activated domains cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(provider, marketplace, legacyContracts, nameWrapper, reverseRegistrar);
  setInterval(() => scanAndPublish(provider, marketplace, legacyContracts, nameWrapper, reverseRegistrar), CACHE_INTERVAL_MS);
}
