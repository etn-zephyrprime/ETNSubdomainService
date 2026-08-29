import { ethers } from "ethers";
import { getMarketplaceSellersCache, setMarketplaceSellersCache } from "../state/marketplaceSellersState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Keeps a small public JSON cache of {seller address -> primary name} in R2 for the "Names For
// Sale" marketplace screen, for the same reason and via the same fix as
// activatedDomainsCache.js's owner/primary-name resolution: useMarketplaceListings.js's
// getActiveListings() was resolving every listing's seller's primary name concurrently
// (Promise.all over every active listing, each internally a multi-call reverse-lookup chain) —
// exactly the pattern that made ethers batch those calls into one oversized JSON-RPC request and
// have Ankr's public RPC reject the whole batch (HTTP 413 "Batch size too large"). Every seller
// was silently showing as a raw address regardless of whether they'd set a primary name, same
// root cause, same fix: resolve server-side, sequentially/safely, publish the result.
//
// Deliberately NOT moving the listing data itself here. getActiveListings() also backs
// getListingForToken() (ManageSubdomain.jsx's live "List for Resale" / "Cancel Listing" gating for
// the connected user's own names), which needs to reflect a just-submitted transaction
// immediately — a 5-minute-stale R2 cache would be a real regression there. Listings stay a live
// on-chain read; only the seller-name resolution (the part that was actually broken) moves here.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
// Was 5 minutes — bumped to 15 as part of cutting this backend's overall RPC volume across the
// board (see rpcProvider.js), same reasoning as every other cache/watcher's own interval bump.
const CACHE_INTERVAL_MS = process.env.MARKETPLACE_SELLERS_CACHE_INTERVAL_MS
  ? parseInt(process.env.MARKETPLACE_SELLERS_CACHE_INTERVAL_MS, 10)
  : 900000;
const VERIFY_CONCURRENCY = 8;

const MARKETPLACE_ABI = [
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
const REVERSE_REGISTRAR_ABI = [
  "function node(address addr) view returns (bytes32)",
  "function defaultResolver() view returns (address)",
];
const RESOLVER_ABI = ["function name(bytes32 node) view returns (string)"];

// Same worker-pool shape used throughout this repo's other caches.
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

async function scanAndPublish(marketplace, reverseRegistrar, provider) {
  if (isRunning) return; // previous run still in flight — skip this tick
  isRunning = true;
  try {
    const nextId = await marketplace.nextListingId();
    const count = Number(nextId) - 1;

    if (count <= 0) {
      await setMarketplaceSellersCache({});
      console.log("📡 Marketplace sellers cache updated — no listings yet");
      return;
    }

    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const raw = await mapWithConcurrency(ids, VERIFY_CONCURRENCY, (id) => marketplace.listings(id));

    const activeSellers = new Set(
      raw.filter((l) => l.active).map((l) => l.seller.toLowerCase())
    );

    if (activeSellers.size === 0) {
      await setMarketplaceSellersCache({});
      console.log("📡 Marketplace sellers cache updated — no active listings");
      return;
    }

    const defaultResolverAddr = await reverseRegistrar.defaultResolver();
    const sellers = {};

    if (defaultResolverAddr !== ethers.ZeroAddress) {
      const resolver = new ethers.Contract(defaultResolverAddr, RESOLVER_ABI, provider);
      await mapWithConcurrency([...activeSellers], VERIFY_CONCURRENCY, async (seller) => {
        sellers[seller] = await resolvePrimaryName(reverseRegistrar, resolver, seller);
      });
    } else {
      for (const seller of activeSellers) sellers[seller] = null;
    }

    await setMarketplaceSellersCache(sellers);

    const resolvedCount = Object.values(sellers).filter(Boolean).length;
    console.log(`📡 Marketplace sellers cache updated — ${activeSellers.size} active seller(s), ${resolvedCount} with a primary name`);
  } catch (err) {
    console.error("⚠️  Marketplace sellers cache scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured — there'd be nowhere
 * public to publish to, same as this repo's other caches.
 */
export function startMarketplaceSellersCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — marketplace sellers cache disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as activatedDomainsCache.js, for the same reason. This is exactly
  // the pattern (many concurrent per-item calls) that triggered Ankr's batch-size rejection there.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const reverseRegistrar = new ethers.Contract(REVERSE_REGISTRAR_ADDRESS, REVERSE_REGISTRAR_ABI, provider);

  console.log(`📡 Marketplace sellers cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(marketplace, reverseRegistrar, provider);
  setInterval(() => scanAndPublish(marketplace, reverseRegistrar, provider), CACHE_INTERVAL_MS);
}
