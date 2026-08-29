import { ethers } from "ethers";
import { getNftSalesCache, setNftSalesCache } from "../state/nftSalesState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Keeps a public JSON cache of real on-chain NFT sale history in R2, for TokenDetail.jsx's NFT
// collection pages — which otherwise have nothing useful to show (an NFT collection isn't an
// ElectroSwap trading pair, so TokenPriceChart.jsx's GeckoTerminal-pool lookup always comes back
// empty for one).
//
// Scans `OrderFulfilled` events on Seaport (0x678748317e7fD5B7699D07e666087608B401cbFd) —
// confirmed to be ElectroSwap's actual NFT marketplace contract (not a guess: every fulfillment
// also fires a FeeDeposited event on their own EsDividendDistributorV2 contract, and this same
// Seaport address is already trusted elsewhere in this codebase as SEAPORT_ADDRESS in
// coreClashConfig.js / coreClashNftSaleWatcher.js). Deliberately pure on-chain data — zero calls
// to electroswap.io in any form.
//
// One real, permanent limitation: Seaport orders are off-chain signed messages — nothing about a
// *listing* ever touches the chain, only its fulfillment or cancellation. There is no on-chain
// "Listing" event, so there's no honest way to compute a floor price (lowest active ask) from
// chain data alone. This cache only ever publishes real, already-settled sales — no floor price,
// no active-listing count. See NftSalesChart.jsx for how the frontend presents this (a "Last
// Sale" headline stat instead of "Floor Price").
//
// Dual-cursor scan, unlike this repo's other single-forward-cursor caches (e.g.
// nameServiceStatsCache.js): Seaport was deployed at block 5,221,734, ~10M+ blocks before chain
// tip at the time this was built — a single "oldest first" forward scan would take on the order
// of a day of 5-minute cycles before it ever reached *today's* sales, leaving this feature
// visibly broken ("no sales yet") the entire time. Recency matters far more than completeness
// here (a sales-history chart is much more useful with only the last few weeks than with only
// 2025's history), so `highScannedBlock` tracks the chain tip and is kept caught up every cycle,
// while `lowScannedBlock` independently backfills older history in the background, oldest-first
// from wherever it last stopped, down toward SEAPORT_DEPLOY_BLOCK. Both halves append into the
// same flat, deduped `sales` array.
const SEAPORT_ADDRESS = (process.env.SEAPORT_ADDRESS || "0x678748317e7fD5B7699D07e666087608B401cbFd").toLowerCase();
const SEAPORT_DEPLOY_BLOCK = process.env.SEAPORT_DEPLOY_BLOCK
  ? parseInt(process.env.SEAPORT_DEPLOY_BLOCK, 10)
  : 5221734;
// Same WETN address duplicated locally in tokenChartRouter.js / coreClashConfig.js — this
// codebase's established convention (each cache owns its own copy rather than sharing a constants
// module). Priced 1:1 with native ETN for this purpose (it's ETN's own wrapped form).
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_INTERVAL_MS = process.env.NFT_SALES_CACHE_INTERVAL_MS
  ? parseInt(process.env.NFT_SALES_CACHE_INTERVAL_MS, 10)
  : 300000;
// Kept small relative to nameServiceStatsCache.js's 50000 — this is a much larger total block
// range to eventually cover, and each cycle does two passes (forward catch-up + backward
// backfill), each its own batch of chunked RPC calls.
const MAX_BLOCKS_PER_CYCLE = process.env.NFT_SALES_MAX_BLOCKS_PER_CYCLE
  ? parseInt(process.env.NFT_SALES_MAX_BLOCKS_PER_CYCLE, 10)
  : 20000;
const MAX_HISTORY_SALES = 3000;
const TIMESTAMP_CONCURRENCY = 8;

const SEAPORT_ABI = [
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, tuple(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer, tuple(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)",
];
const ITEM_TYPE_NATIVE = 0;
const ITEM_TYPE_ERC20 = 1;
const ITEM_TYPE_ERC721 = 2;
const ITEM_TYPE_ERC1155 = 3;

const MIN_CHUNK_SIZE = 50;
const MAX_FLOOR_RETRIES = 6;
const FLOOR_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same range-adaptive chunked/concurrent log scan duplicated across this repo's caches — see
// subnameDomainsCache.js's comment for the full reasoning.
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

// Finds the NFT item in a Seaport offer/consideration array, if any — an order can carry an NFT
// on either side (offer = a seller listing it for sale; consideration = a buyer bidding on it),
// same both-directions check coreClashNftSaleWatcher.js's findTrackedErc721 does, generalized
// here to ERC-1155 too (that watcher only ever needed ERC-721 for its four known collections).
function findNftItem(items) {
  for (const item of items || []) {
    const itemType = Number(item.itemType);
    if (itemType !== ITEM_TYPE_ERC721 && itemType !== ITEM_TYPE_ERC1155) continue;
    return { contractAddress: String(item.token).toLowerCase(), tokenId: String(item.identifier) };
  }
  return null;
}

// Sums the fungible (native + ERC20) side of an order into one payment total — ported from
// coreClashNftSaleWatcher.js's sumFungible. Correct for the common case seen live on this chain
// (a seller-payment entry plus a same-currency marketplace-fee entry); a genuinely mixed-currency
// consideration is not something Seaport orders normally construct.
function sumFungible(items) {
  let total = 0n;
  let paymentToken = null;
  let paymentItemType = null;

  for (const item of items || []) {
    const itemType = Number(item.itemType);
    if (itemType !== ITEM_TYPE_NATIVE && itemType !== ITEM_TYPE_ERC20) continue;
    total += BigInt(item.amount);
    if (paymentToken == null) {
      paymentToken = String(item.token || "").toLowerCase();
      paymentItemType = itemType;
    }
  }

  return { amountRaw: total, paymentToken, paymentItemType };
}

// null priceWei (rather than a misleading number) whenever the payment currency isn't ETN or its
// wrapped form — a real sale still gets recorded (tokenId/buyer/seller/tx are all still true), it
// just can't contribute a price point to the chart/"Last Sale" stat.
function priceWeiInEtn(payment) {
  if (payment.amountRaw <= 0n) return null;
  if (payment.paymentItemType === ITEM_TYPE_NATIVE) return payment.amountRaw.toString();
  if (payment.paymentItemType === ITEM_TYPE_ERC20 && payment.paymentToken === WETN_ADDRESS) return payment.amountRaw.toString();
  return null;
}

async function scanRange(seaport, provider, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];

  const logs = await queryLogsChunked(seaport, seaport.filters.OrderFulfilled(), fromBlock, toBlock);
  if (logs.length === 0) return [];

  const uniqueBlocks = [...new Set(logs.map((e) => e.blockNumber))];
  const blockTimestamps = new Map();
  await mapWithConcurrency(uniqueBlocks, TIMESTAMP_CONCURRENCY, async (blockNumber) => {
    try {
      const block = await provider.getBlock(blockNumber);
      blockTimestamps.set(blockNumber, block ? block.timestamp * 1000 : null);
    } catch (err) {
      console.warn(`⚠️  NFT sales: failed to fetch timestamp for block ${blockNumber}:`, err.message);
      blockTimestamps.set(blockNumber, null);
    }
  });

  const sales = [];
  for (const event of logs) {
    const timestampMs = blockTimestamps.get(event.blockNumber);
    if (timestampMs == null) continue; // couldn't get a real timestamp — skip rather than fake one

    const offerer = String(event.args.offerer).toLowerCase();
    const recipient = String(event.args.recipient).toLowerCase();

    const inOffer = findNftItem(event.args.offer);
    const inConsideration = inOffer ? null : findNftItem(event.args.consideration);
    const nft = inOffer || inConsideration;
    if (!nft) continue; // this order didn't involve an NFT at all — not our concern here

    // offer-side NFT: a seller listed it, buyer (recipient) fulfilled — payment is consideration.
    // consideration-side NFT: a bid on an NFT, offerer paid, recipient (NFT owner) fulfilled the
    // sale by accepting — payment is offer. Same both-directions logic as
    // coreClashNftSaleWatcher.js.
    const seller = inOffer ? offerer : recipient;
    const buyer = inOffer ? recipient : offerer;
    const payment = sumFungible(inOffer ? event.args.consideration : event.args.offer);

    sales.push({
      collectionAddress: nft.contractAddress,
      tokenId: nft.tokenId,
      priceWei: priceWeiInEtn(payment),
      seller,
      buyer,
      timestampMs,
      txHash: event.transactionHash,
    });
  }

  return sales;
}

let isRunning = false;

async function scanAndPublish(seaport, provider) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rawCached = await getNftSalesCache();
    const cached = rawCached?.schemaVersion === CACHE_SCHEMA_VERSION ? rawCached : null;
    const sales = Array.isArray(cached?.sales) ? cached.sales.slice() : [];
    const seenKeys = new Set(sales.map((s) => `${s.txHash}:${s.collectionAddress}:${s.tokenId}`));

    const latestBlock = await provider.getBlockNumber();

    let highScannedBlock = cached?.highScannedBlock ?? null;
    let lowScannedBlock = cached?.lowScannedBlock ?? null;
    const newSales = [];

    if (highScannedBlock == null) {
      // First run ever — start the "recent" window at chain tip so there's something real to
      // show immediately, rather than beginning the whole history at SEAPORT_DEPLOY_BLOCK.
      const fromBlock = Math.max(SEAPORT_DEPLOY_BLOCK, latestBlock - MAX_BLOCKS_PER_CYCLE + 1);
      newSales.push(...(await scanRange(seaport, provider, fromBlock, latestBlock)));
      highScannedBlock = latestBlock;
      lowScannedBlock = fromBlock;
    } else {
      // Catch up to chain tip first (small range most cycles — CACHE_INTERVAL_MS apart).
      if (latestBlock > highScannedBlock) {
        const fromBlock = highScannedBlock + 1;
        newSales.push(...(await scanRange(seaport, provider, fromBlock, latestBlock)));
        highScannedBlock = latestBlock;
      }
      // Then spend one more chunk backfilling older history, if there's any left to cover.
      if (lowScannedBlock > SEAPORT_DEPLOY_BLOCK) {
        const toBlock = lowScannedBlock - 1;
        const fromBlock = Math.max(SEAPORT_DEPLOY_BLOCK, toBlock - MAX_BLOCKS_PER_CYCLE + 1);
        newSales.push(...(await scanRange(seaport, provider, fromBlock, toBlock)));
        lowScannedBlock = fromBlock;
      }
    }

    for (const sale of newSales) {
      const key = `${sale.txHash}:${sale.collectionAddress}:${sale.tokenId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      sales.push(sale);
    }

    sales.sort((a, b) => a.timestampMs - b.timestampMs);
    const trimmedSales = sales.length > MAX_HISTORY_SALES ? sales.slice(sales.length - MAX_HISTORY_SALES) : sales;

    await setNftSalesCache({
      sales: trimmedSales,
      lowScannedBlock,
      highScannedBlock,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    const backfillPct = ((highScannedBlock - lowScannedBlock) / (latestBlock - SEAPORT_DEPLOY_BLOCK) * 100).toFixed(1);
    console.log(`🖼️  NFT sales cache updated — ${trimmedSales.length} sale(s) tracked, history backfilled ${backfillPct}%, caught up to block ${highScannedBlock}`);
  } catch (err) {
    console.error("⚠️  NFT sales scan failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches.
 */
export function startNftSalesCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — NFT sales cache disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as this repo's other per-item-call-heavy caches.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, provider);

  console.log(`🖼️  NFT sales cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  scanAndPublish(seaport, provider);
  setInterval(() => scanAndPublish(seaport, provider), CACHE_INTERVAL_MS);
}
