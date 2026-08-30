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

const BLOCKSCOUT_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const MAX_RETRIES = 3;
const PAGE_DELAY_MS = process.env.PNL_INGESTION_PAGE_DELAY_MS ? parseInt(process.env.PNL_INGESTION_PAGE_DELAY_MS, 10) : 150;

const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Collects and classifies a wallet's raw transfers (native + tokens) and gas fees across both the
 * /transactions and /internal-transactions endpoints. Swap detection/decomposition is layered on
 * top separately (see ingestSwaps) rather than folded in here, since a swap's own token-transfer
 * legs would otherwise double-count as plain transfers too. */
async function ingestTransfersAndGas(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/transactions`, stopAtBlock, async (items) => {
    for (const tx of items) {
      highestBlock = Math.max(highestBlock, Number(tx.block_number));
      const fromLc = String(tx.from?.hash || "").toLowerCase();
      const toLc = String(tx.to?.hash || "").toLowerCase();
      const timestamp = new Date(tx.timestamp);

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
        const isSwap = swapTxHashes.has(tx.hash.toLowerCase());
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

      const decimals = Number(tt.token?.decimals ?? 18);
      const amountRaw = BigInt(tt.total?.value || "0");
      const timestamp = new Date(tt.timestamp);
      const tokenAddress = tt.token?.address;
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

/** Finds Swap events involving the tracked wallet within its own transaction history, by fetching
 * each transaction's logs and checking for the Swap topic — see this file's header comment on the
 * detection heuristic and its known limitations. Returns the set of matched tx hashes (lowercased)
 * so ingestTransfersAndGas can skip those legs as plain transfers, and writes swap_trades rows. */
async function ingestSwaps(trackedWallet, stopAtBlock) {
  const walletLc = trackedWallet.toLowerCase();
  const swapTxHashes = new Set();
  const swapRows = [];

  // Only worth checking transactions that are actually contract interactions with token transfers
  // attached — Blockscout's /transactions items already embed a token_transfers array per tx
  // (confirmed live), which is exactly the filter needed here without a second per-tx fetch.
  await walkAllPages(`/addresses/${trackedWallet}/transactions`, stopAtBlock, async (items) => {
    for (const tx of items) {
      const tokenTransfers = tx.token_transfers || [];
      if (tokenTransfers.length === 0 || !tx.to?.is_contract) continue;

      let logsPage;
      try {
        logsPage = await fetchPage(`/transactions/${tx.hash}/logs`, null);
      } catch (err) {
        console.warn(`⚠️  Ingestion: could not fetch logs for tx ${tx.hash}, skipping swap detection for it:`, err.message);
        continue;
      }

      const swapLog = (logsPage.items || []).find((l) => (l.topics || [])[0] === SWAP_TOPIC);
      if (!swapLog) continue;

      let parsed;
      try {
        // Blockscout pads `topics` to a fixed length with trailing nulls for unused slots
        // (confirmed live) — ethers' parseLog expects exactly as many topics as the event
        // actually uses (1 signature + N indexed params), not a padded array.
        const realTopics = (swapLog.topics || []).filter((t) => t != null);
        parsed = SWAP_IFACE.parseLog({ topics: realTopics, data: swapLog.data });
      } catch {
        continue;
      }

      const sender = String(parsed.args.sender).toLowerCase();
      const to = String(parsed.args.to).toLowerCase();
      if (sender !== walletLc && to !== walletLc) continue; // this Swap log isn't this wallet's trade

      // Determine which leg the wallet actually sold/bought via the tx's own decoded token
      // transfers — restricted to transfers directly between the wallet and THIS pool
      // (swapLog.address), not just "any transfer from/to the wallet anywhere in the tx".
      // Confirmed live this distinction matters: a tx can contain unrelated later transfers
      // (e.g. a buyBackAndBurn's burn-to-zero-address leg) that would otherwise be misattributed
      // as a swap leg if matched by wallet address alone. A pure ETN<->token swap has only one
      // pool<->wallet token-transfer leg; the other leg is the tx's own native value (handled by
      // ingestTransfersAndGas's plain-native-transfer logic being skipped for this tx hash, then
      // re-attributed here as the swap's ETN leg).
      const poolLc = String(swapLog.address?.hash || swapLog.address).toLowerCase();
      const sold = tokenTransfers.find(
        (t) => String(t.from?.hash).toLowerCase() === walletLc && String(t.to?.hash).toLowerCase() === poolLc
      );
      const bought = tokenTransfers.find(
        (t) => String(t.to?.hash).toLowerCase() === walletLc && String(t.from?.hash).toLowerCase() === poolLc
      );
      const timestamp = new Date(tx.timestamp);
      const nativeValue = BigInt(tx.value || "0");

      const soldAddress = sold ? sold.token.address : "NATIVE";
      const soldAmount = sold ? weiToDecimal(BigInt(sold.total.value), Number(sold.token.decimals)) : weiToDecimal(nativeValue);
      const boughtAddress = bought ? bought.token.address : "NATIVE";
      const boughtAmount = bought ? weiToDecimal(BigInt(bought.total.value), Number(bought.token.decimals)) : weiToDecimal(nativeValue);

      if (!sold && !bought) continue; // couldn't identify either leg — don't fabricate a trade

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
    }
  });

  if (swapRows.length > 0) await insertSwapTrades(swapRows);
  return swapTxHashes;
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

  const swapTxHashes = await ingestSwaps(trackedWallet, stopAtBlock);
  const highestBlock = await ingestTransfersAndGas(trackedWallet, selfOwnedSet, stopAtBlock, swapTxHashes);

  if (highestBlock >= 0) {
    await upsertIngestionState(trackedWallet, {
      lastIngestedBlock: highestBlock,
      coldStartCompletedAt: state?.cold_start_completed_at || new Date(),
    });
  }

  console.log(`📥 Ingestion complete for ${trackedWallet} — caught up to block ${highestBlock}, ${swapTxHashes.size} swap(s) detected`);
}
