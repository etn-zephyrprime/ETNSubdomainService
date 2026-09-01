// backend/services/pnlIngestion.js
//
// Per-wallet transfer/trade history ingestion — triggered fresh at statement *request* time, not
// a standing background cron (per the build brief: a wallet's history isn't kept continuously
// current for every tracked wallet regardless of whether a statement was ever requested). On a
// wallet's first-ever request, ingests full history back to its first transaction; subsequent
// requests backfill/confirm anything missed since the last one rather than trusting a
// continuously-running job kept it current (there isn't one).
//
// Scans three Blockscout v2 endpoints per wallet, each with the same keyset-pagination + retry
// shape already proven in dailyBlockStatsCache.js/validatorRewardsCache.js:
//   - /addresses/{address}/transactions        — gas paid by the wallet's own txs, top-level ETN
//   - /addresses/{address}/token-transfers     — ERC20 in/out
//   - /addresses/{address}/internal-transactions — ETN moved by contract calls (e.g. swap
//     proceeds) — invisible to both the plain transaction list and eth_getLogs
//
// SWAP DETECTION — flagged for empirical verification during testnet testing (not yet confirmed
// against a real ElectroSwap trade from an arbitrary wallet, only against the CORE/WETN pool
// specifically in coreClashSwapWatcher.js): a transaction is treated as a swap when it decoded a
// `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out,
// uint256 amount1Out, address indexed to)` log for the tracked wallet (as `sender` or `to`) on any
// address that also appears as the `token`/pool side of one of that same tx's token-transfers.
// Getting this wrong just means an occasional swap shows up as two separate transfers instead of
// one decomposed disposal+acquisition — degrades gracefully, doesn't corrupt totals — but should
// be spot-checked against real trade history before this goes live.
import { ethers } from "ethers";
import { getIngestionState, upsertIngestionState } from "../db/walletIngestionState.js";
import { insertTransfers } from "../db/ingestedTransfers.js";
import { insertSwapTrades } from "../db/swapTrades.js";
import { isCexAddress } from "../db/cexAddresses.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { createPrimaryNameResolver } from "../utils/primaryNameResolver.js";

const BLOCKSCOUT_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
export const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
// Blockscout's legacy Etherscan-compatible API — the v2 REST API above has no block-by-timestamp
// equivalent. Used only by getBlockByTimestamp below.
const BLOCKSCOUT_LEGACY_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api`;
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS / coreClashConfig.js's own copy — used
// only by resolveEnsDisplayName below.
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
const MAX_RETRIES = 3;
const PAGE_DELAY_MS = process.env.PNL_INGESTION_PAGE_DELAY_MS ? parseInt(process.env.PNL_INGESTION_PAGE_DELAY_MS, 10) : 150;

const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves the block number closest to `timestamp` via Blockscout's legacy Etherscan-compatible
 * API (module=block&action=getblocknobytime) — informational only, for showing a human-checkable
 * block range on a generated statement (see pnlStatementGenerator.js). Never used for the actual
 * period slicing, which stays timestamp-based (see that file's header comment on why: ingestion
 * pages through Blockscout's v2 endpoints by keyset cursor, not block range). `closest` is
 * Blockscout's own param — "before" or "after". */
export async function getBlockByTimestamp(timestamp, closest = "before") {
  const unixSeconds = Math.floor(timestamp.getTime() / 1000);
  const url = `${BLOCKSCOUT_LEGACY_API_BASE}?module=block&action=getblocknobytime&timestamp=${unixSeconds}&closest=${closest}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} resolving block by timestamp`);
  const json = await res.json();
  if (json.status !== "1" || !json.result?.blockNumber) {
    throw new Error(`Unexpected response resolving block by timestamp: ${JSON.stringify(json)}`);
  }
  return Number(json.result.blockNumber);
}

// Token name/symbol never changes post-deploy in any way this app cares about — no TTL needed,
// unlike the price caches elsewhere in this feature.
const tokenMetadataCache = new Map(); // address (lowercase) -> { name, symbol } | null

/** Resolves a token's name/symbol via Blockscout, cached indefinitely per address. Returns null
 * (not a throw) on any failure — callers treat missing metadata as "show the raw address instead",
 * never as a reason to fail statement generation. */
export async function getTokenMetadata(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenMetadataCache.has(key)) return tokenMetadataCache.get(key);

  let result = null;
  try {
    const res = await fetch(`${BLOCKSCOUT_API_BASE}/tokens/${tokenAddress}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.name || json.symbol) result = { name: json.name || null, symbol: json.symbol || null };
  } catch (err) {
    console.warn(`⚠️  Could not fetch token metadata for ${tokenAddress}:`, err.message);
  }
  tokenMetadataCache.set(key, result);
  return result;
}

// Reuses the exact same ReverseRegistrar+resolver chain the Core Clash Telegram bots already use
// (see primaryNameResolver.js's own header comment on why this is centralized rather than
// reimplemented per call site) — one shared resolver instance/provider for the life of the
// process, not per-call.
let cachedEnsResolver = null;
function getEnsResolver() {
  if (!cachedEnsResolver) {
    const provider = createRpcProvider();
    cachedEnsResolver = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);
  }
  return cachedEnsResolver;
}

/** Resolves `address`'s primary ENS name, or null if it doesn't have one / resolution fails —
 * callers show the raw address either way (see formatAssetLabel-style callers in
 * pnlStatementGenerator.js), this only ever adds a friendlier name alongside it, never replaces
 * the address as the source of truth. */
export async function resolveEnsDisplayName(address) {
  try {
    const resolveDisplayName = getEnsResolver();
    const result = await resolveDisplayName(address);
    // primaryNameResolver's own contract falls back to a shortened address string (e.g.
    // "0x1234...abcd") when there's no primary name set — that's not a real ENS name, so callers
    // here want null instead of that shortened-address fallback (this file already has the full
    // address on hand and formats it consistently itself).
    return result && result.startsWith("0x") ? null : result;
  } catch (err) {
    console.warn(`⚠️  Could not resolve ENS name for ${address}:`, err.message);
    return null;
  }
}

async function fetchPage(path, cursorParams, attempt = 0) {
  const url = new URL(`${BLOCKSCOUT_API_BASE}${path}`);
  if (cursorParams) {
    for (const [key, value] of Object.entries(cursorParams)) url.searchParams.set(key, value);
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchPage(path, cursorParams, attempt + 1);
    }
    throw err;
  }
}

/** Walks every page of a Blockscout address-scoped endpoint, calling `onPage(items)` for each,
 * until next_page_params is exhausted or an item's block is at/below `stopAtBlock` (exclusive —
 * used for incremental catch-up, where we only want blocks newer than the last ingested one;
 * pass null to walk the endpoint's entire available history, used for cold start). */
async function walkAllPages(path, stopAtBlock, onPage) {
  let cursor;
  for (;;) {
    const page = await fetchPage(path, cursor);
    const items = page.items || [];
    if (items.length === 0) break;

    const relevant = stopAtBlock != null ? items.filter((it) => Number(it.block_number) > stopAtBlock) : items;
    if (relevant.length > 0) await onPage(relevant);

    if (relevant.length < items.length || !page.next_page_params) break; // rest of this page (and everything after) is already-ingested territory
    cursor = page.next_page_params;
    await sleep(PAGE_DELAY_MS);
  }
}

function weiToDecimal(wei, decimals = 18) {
  return Number(ethers.formatUnits(wei, decimals));
}

async function priceOrNull(asset, timestamp) {
  try {
    return await getHistoricalPriceUsd(asset, timestamp);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not price ${asset} @ ${timestamp.toISOString()}:`, err.message);
    return null;
  }
}

/** Detects whether a single /transactions item `tx` is an ElectroSwap trade — same heuristic as
 * before (see this file's header comment): fetch the tx's logs, look for a Swap topic naming the
 * tracked wallet as sender/to, then match the sold/bought legs against its own token_transfers.
 * Only ever called for contract-interaction txs that already have token transfers attached
 * (checked by the caller), so this is never wasted on a plain ETN send. On a match, records the
 * trade into `swapRows` and the tx hash into `swapTxHashes`, and returns true so the caller skips
 * emitting this tx's native/token legs as plain transfers instead. */
async function detectAndRecordSwap(trackedWallet, walletLc, tx, tokenTransfers, swapTxHashes, swapRows) {
  let logsPage;
  try {
    logsPage = await fetchPage(`/transactions/${tx.hash}/logs`, null);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not fetch logs for tx ${tx.hash}, skipping swap detection for it:`, err.message);
    return false;
  }

  const swapLog = (logsPage.items || []).find((l) => (l.topics || [])[0] === SWAP_TOPIC);
  if (!swapLog) return false;

  let parsed;
  try {
    // Blockscout pads `topics` to a fixed length with trailing nulls for unused slots (confirmed
    // live) — ethers' parseLog expects exactly as many topics as the event actually uses (1
    // signature + N indexed params), not a padded array.
    const realTopics = (swapLog.topics || []).filter((t) => t != null);
    parsed = SWAP_IFACE.parseLog({ topics: realTopics, data: swapLog.data });
  } catch {
    return false;
  }

  const sender = String(parsed.args.sender).toLowerCase();
  const to = String(parsed.args.to).toLowerCase();
  if (sender !== walletLc && to !== walletLc) return false; // this Swap log isn't this wallet's trade

  // Determine which leg the wallet actually sold/bought via the tx's own decoded token transfers —
  // restricted to transfers directly between the wallet and THIS pool (swapLog.address), not just
  // "any transfer from/to the wallet anywhere in the tx". Confirmed live this distinction matters:
  // a tx can contain unrelated later transfers (e.g. a buyBackAndBurn's burn-to-zero-address leg)
  // that would otherwise be misattributed as a swap leg if matched by wallet address alone. A pure
  // ETN<->token swap has only one pool<->wallet token-transfer leg; the other leg is the tx's own
  // native value (handled by the caller's plain-native-transfer logic being skipped for this tx
  // hash, since this function returning true means it's a swap leg instead).
  const poolLc = String(swapLog.address?.hash || swapLog.address).toLowerCase();
  const sold = tokenTransfers.find(
    (t) => String(t.from?.hash).toLowerCase() === walletLc && String(t.to?.hash).toLowerCase() === poolLc
  );
  const bought = tokenTransfers.find(
    (t) => String(t.to?.hash).toLowerCase() === walletLc && String(t.from?.hash).toLowerCase() === poolLc
  );
  if (!sold && !bought) return false; // couldn't identify either leg — don't fabricate a trade

  const timestamp = new Date(tx.timestamp);
  const nativeValue = BigInt(tx.value || "0");

  const soldAddress = sold ? sold.token.address : "NATIVE";
  const soldAmount = sold ? weiToDecimal(BigInt(sold.total.value), Number(sold.token.decimals)) : weiToDecimal(nativeValue);
  const boughtAddress = bought ? bought.token.address : "NATIVE";
  const boughtAmount = bought ? weiToDecimal(BigInt(bought.total.value), Number(bought.token.decimals)) : weiToDecimal(nativeValue);

  const [priceSold, priceBought] = await Promise.all([
    priceOrNull(soldAddress, timestamp),
    priceOrNull(boughtAddress, timestamp),
  ]);

  swapTxHashes.add(tx.hash.toLowerCase());
  swapRows.push({
    trackedWallet,
    txHash: tx.hash,
    logIndex: Number(swapLog.index ?? 0),
    poolAddress: swapLog.address?.hash || swapLog.address, // Blockscout returns an address object ({hash, ...}), not a bare string
    tokenSoldAddress: soldAddress,
    amountSold: soldAmount,
    tokenBoughtAddress: boughtAddress,
    amountBought: boughtAmount,
    priceUsdSoldLeg: priceSold,
    priceUsdBoughtLeg: priceBought,
    blockNumber: Number(tx.block_number),
    timestamp,
  });
  return true;
}

/** Walks /addresses/{wallet}/transactions exactly once, doing BOTH swap detection and gas/plain-
 * native-transfer extraction in the same per-tx pass. These used to be two entirely separate full
 * walks of this same endpoint (one in a since-removed ingestSwaps, one here) — pure waste, since
 * whether a given tx is a swap never depends on any *other* tx, so both can be decided together
 * with no ordering hazard. For a high-activity wallet this endpoint is usually the largest of the
 * three by page count, so halving its walks (on top of removing the duplicate) is where most of
 * this refactor's win comes from. Returns { swapTxHashes, highestBlock } — swapTxHashes feeds
 * ingestInternalTransactions/ingestTokenTransfers below, which still run after this completes,
 * since they filter on the now-complete set. */
async function ingestTransactionsGasAndSwaps(trackedWallet, selfOwnedSet, stopAtBlock) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  const swapTxHashes = new Set();
  const swapRows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/transactions`, stopAtBlock, async (items) => {
    for (const tx of items) {
      highestBlock = Math.max(highestBlock, Number(tx.block_number));
      const fromLc = String(tx.from?.hash || "").toLowerCase();
      const toLc = String(tx.to?.hash || "").toLowerCase();
      const timestamp = new Date(tx.timestamp);

      // Only worth checking transactions that are actually contract interactions with token
      // transfers attached — Blockscout's /transactions items already embed a token_transfers
      // array per tx (confirmed live), which is exactly the filter needed here without a second
      // per-tx fetch for every plain ETN send.
      const tokenTransfers = tx.token_transfers || [];
      const isSwap =
        tokenTransfers.length > 0 && tx.to?.is_contract
          ? await detectAndRecordSwap(trackedWallet, walletLc, tx, tokenTransfers, swapTxHashes, swapRows)
          : false;

      // Gas is only ever charged to whoever actually sent the transaction.
      if (fromLc === walletLc && tx.gas_used && tx.gas_price) {
        const gasFeeWei = BigInt(tx.gas_used) * BigInt(tx.gas_price);
        rows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -1,
          direction: "out",
          counterpartyAddress: toLc || walletLc,
          isSelfTransfer: false, // gas is never a self-transfer — it's genuinely spent
          isCex: false,
          assetType: "native",
          tokenAddress: null,
          tokenId: null,
          amountRaw: 0n, // this row represents ONLY the gas fee, not a value transfer — see the plain-ETN-value row below when value > 0
          amountDecimal: 0,
          priceUsdAtTime: null,
          usdValue: null,
          gasFeeWei,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }

      // Plain top-level native ETN transfer (tx.value), separate from the gas-fee row above.
      const value = BigInt(tx.value || "0");
      if (value > 0n && (fromLc === walletLc || toLc === walletLc) && fromLc !== toLc) {
        if (isSwap) continue; // the swap leg is recorded via swap_trades instead, not as a plain transfer
        const direction = fromLc === walletLc ? "out" : "in";
        const counterparty = direction === "out" ? toLc : fromLc;
        const isSelf = selfOwnedSet.has(counterparty);
        const isCex = !isSelf && (await isCexAddress(counterparty));
        const priceUsd = await priceOrNull("NATIVE", timestamp);
        rows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -2, // distinct sentinel from the gas row's -1, since both can exist for the same tx_hash
          direction,
          counterpartyAddress: counterparty,
          isSelfTransfer: isSelf,
          isCex,
          assetType: "native",
          tokenAddress: null,
          tokenId: null,
          amountRaw: value,
          amountDecimal: weiToDecimal(value),
          priceUsdAtTime: priceUsd,
          usdValue: priceUsd != null ? weiToDecimal(value) * priceUsd : null,
          gasFeeWei: null,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }
    }
  });

  if (rows.length > 0) await insertTransfers(rows);
  if (swapRows.length > 0) await insertSwapTrades(swapRows);
  return { swapTxHashes, highestBlock };
}

/** Walks /addresses/{wallet}/internal-transactions — ETN moved by contract calls, invisible to
 * both the plain transaction list and eth_getLogs. Independent of ingestTokenTransfers below (each
 * only touches its own endpoint/rows), so the caller runs the two concurrently. */
async function ingestInternalTransactions(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/internal-transactions`, stopAtBlock, async (items) => {
    for (const itx of items) {
      highestBlock = Math.max(highestBlock, Number(itx.block_number));
      if (itx.success === false) continue;
      const fromLc = String(itx.from?.hash || "").toLowerCase();
      const toLc = String(itx.to?.hash || "").toLowerCase();
      const value = BigInt(itx.value || "0");
      if (value === 0n || fromLc === toLc) continue;
      if (fromLc !== walletLc && toLc !== walletLc) continue;
      if (swapTxHashes.has(String(itx.transaction_hash).toLowerCase())) continue;

      const timestamp = new Date(itx.timestamp);
      const direction = fromLc === walletLc ? "out" : "in";
      const counterparty = direction === "out" ? toLc : fromLc;
      const isSelf = selfOwnedSet.has(counterparty);
      const isCex = !isSelf && (await isCexAddress(counterparty));
      const priceUsd = await priceOrNull("NATIVE", timestamp);
      rows.push({
        trackedWallet,
        txHash: itx.transaction_hash,
        logIndex: -(1000 + Number(itx.index || 0)), // internal-tx index, offset well clear of -1/-2 sentinels above
        direction,
        counterpartyAddress: counterparty,
        isSelfTransfer: isSelf,
        isCex,
        assetType: "native",
        tokenAddress: null,
        tokenId: null,
        amountRaw: value,
        amountDecimal: weiToDecimal(value),
        priceUsdAtTime: priceUsd,
        usdValue: priceUsd != null ? weiToDecimal(value) * priceUsd : null,
        gasFeeWei: null,
        blockNumber: Number(itx.block_number),
        timestamp,
      });
    }
  });

  if (rows.length > 0) await insertTransfers(rows);
  return highestBlock;
}

/** Walks /addresses/{wallet}/token-transfers — ERC20/721/1155 in/out. Independent of
 * ingestInternalTransactions above, so the caller runs the two concurrently. */
async function ingestTokenTransfers(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/token-transfers`, stopAtBlock, async (items) => {
    for (const tt of items) {
      highestBlock = Math.max(highestBlock, Number(tt.block_number));
      if (swapTxHashes.has(String(tt.transaction_hash).toLowerCase())) continue;

      const fromLc = String(tt.from?.hash || "").toLowerCase();
      const toLc = String(tt.to?.hash || "").toLowerCase();
      if (fromLc === toLc) continue;
      const direction = fromLc === walletLc ? "out" : "in";
      const counterparty = direction === "out" ? toLc : fromLc;
      const isSelf = selfOwnedSet.has(counterparty);
      const isCex = !isSelf && (await isCexAddress(counterparty));

      const timestamp = new Date(tt.timestamp);
      const tokenAddress = tt.token?.address;
      const tokenType = tt.token?.type; // "ERC-20" | "ERC-721" | "ERC-1155" — confirmed live shape

      if (tokenType === "ERC-721" || tokenType === "ERC-1155") {
        // NFTs have no `total.value`/decimals at all (confirmed live: total is
        // { token_id, token_instance }, decimals is null) — previously this fell through to the
        // ERC-20 branch below, BigInt(undefined || "0") silently produced amountRaw=0, and every
        // amount_raw=0 filter elsewhere in this codebase (flows, transaction history) then dropped
        // the row entirely. Each NFT is a distinct, individually-cost-tracked asset (see
        // fifoLotEngine.js's "tokenAddress:tokenId" lot-key convention), not a fungible quantity —
        // ERC-1155 IS technically semi-fungible (total.value can be >1 of the same tokenId), so its
        // quantity is read from total.value when present; ERC-721 is always exactly 1.
        const tokenId = tt.total?.token_id != null ? String(tt.total.token_id) : null;
        const quantity = tokenType === "ERC-1155" && tt.total?.value ? BigInt(tt.total.value) : 1n;
        rows.push({
          trackedWallet,
          txHash: tt.transaction_hash,
          logIndex: Number(tt.log_index),
          direction,
          counterpartyAddress: counterparty,
          isSelfTransfer: isSelf,
          isCex,
          assetType: tokenType === "ERC-721" ? "erc721" : "erc1155",
          tokenAddress,
          tokenId,
          amountRaw: quantity,
          amountDecimal: Number(quantity),
          priceUsdAtTime: null, // NFTs have no fungible-market price feed — cost basis/proceeds come from correlated same-tx payments instead, see pnlStatementGenerator.js's buildNftEvents
          usdValue: null,
          gasFeeWei: null,
          blockNumber: Number(tt.block_number),
          timestamp,
        });
        continue;
      }

      const decimals = Number(tt.token?.decimals ?? 18);
      const amountRaw = BigInt(tt.total?.value || "0");
      const priceUsd = await priceOrNull(tokenAddress, timestamp);
      const amountDecimal = weiToDecimal(amountRaw, decimals);

      rows.push({
        trackedWallet,
        txHash: tt.transaction_hash,
        logIndex: Number(tt.log_index),
        direction,
        counterpartyAddress: counterparty,
        isSelfTransfer: isSelf,
        isCex,
        assetType: "erc20",
        tokenAddress,
        tokenId: null,
        amountRaw,
        amountDecimal,
        priceUsdAtTime: priceUsd,
        usdValue: priceUsd != null ? amountDecimal * priceUsd : null,
        gasFeeWei: null,
        blockNumber: Number(tt.block_number),
        timestamp,
      });
    }
  });

  if (rows.length > 0) await insertTransfers(rows);
  return highestBlock;
}

/**
 * Ingests (or backfills) `trackedWallet`'s on-chain history. `selfOwnedAddresses` are the user's
 * other addresses, used to flag self-transfers (excluded from FIFO disposal — see fifoLotEngine.js).
 * Safe to call repeatedly for the same wallet — always resumes from wallet_ingestion_state's
 * last_ingested_block rather than re-scanning from scratch.
 */
export async function ingestWalletHistory(trackedWallet, selfOwnedAddresses = []) {
  const selfOwnedSet = new Set([trackedWallet.toLowerCase(), ...selfOwnedAddresses.map((a) => a.toLowerCase())]);
  const state = await getIngestionState(trackedWallet);
  const stopAtBlock = state?.last_ingested_block > 0 ? state.last_ingested_block : null;

  console.log(`📥 Ingesting history for ${trackedWallet}${stopAtBlock ? ` (resuming after block ${stopAtBlock})` : " (cold start — full history)"}`);

  // /transactions must go first (and complete) — it's the only source of swapTxHashes, which the
  // other two need to correctly skip a swap's legs. Those two are independent of each other, so
  // they run concurrently rather than sequentially — see each function's own comment for why this
  // is a meaningful restructure, not just a stylistic change: /transactions used to be walked
  // twice (once here, once in a separate swap-detection pass) and all three walks used to run
  // fully sequentially.
  const { swapTxHashes, highestBlock: highestFromTx } = await ingestTransactionsGasAndSwaps(trackedWallet, selfOwnedSet, stopAtBlock);
  const [highestFromInternal, highestFromTokens] = await Promise.all([
    ingestInternalTransactions(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes),
    ingestTokenTransfers(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes),
  ]);
  const highestBlock = Math.max(highestFromTx, highestFromInternal, highestFromTokens);

  if (highestBlock >= 0) {
    await upsertIngestionState(trackedWallet, {
      lastIngestedBlock: highestBlock,
      coldStartCompletedAt: state?.cold_start_completed_at || new Date(),
    });
  }

  console.log(`📥 Ingestion complete for ${trackedWallet} — caught up to block ${highestBlock}, ${swapTxHashes.size} swap(s) detected`);
}
