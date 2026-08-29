// backend/utils/coreClashNftSaleWatcher.js
//
// Ported from CoreClashGame/backend/nftMarketplaceListener.js. Watches Seaport's OrderFulfilled
// events for sales involving any of the four Core Clash NFT collections (as either the offered
// or the bid-on item) and posts a Telegram alert. Same text-only simplification as
// coreClashNftMintWatcher.js — see that file's comment for why.
import { ethers } from "ethers";
import { getState, setState } from "../state/coreClashState.js";
import { sendZephyrosMessage, escapeHtml, zephyrosBotConfigured, NFT_THREAD_ID } from "./coreClashTelegram.js";
import { EXPLORER_BASE_URL, ELECTROSWAP_BASE_URL, REVERSE_REGISTRAR_ADDRESS, SEAPORT_ADDRESS, NFT_COLLECTION_MAP, POLL_INTERVAL_MS, LOOKBACK_BLOCKS } from "./coreClashConfig.js";
import { createRpcProvider } from "./rpcProvider.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";

const STATE_KEY = "nft-sale-watcher";
const MAX_BLOCK_RANGE = 100;

const SEAPORT_ABI = [
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, tuple(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer, tuple(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)",
];
const ERC20_MIN_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const ITEM_TYPE_NATIVE = 0;
const ITEM_TYPE_ERC20 = 1;
const ITEM_TYPE_ERC721 = 2;

const IFACE = new ethers.Interface(SEAPORT_ABI);
const ORDER_FULFILLED_TOPIC = ethers.id(
  "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])"
);

function findTrackedErc721(items) {
  for (const item of items || []) {
    if (Number(item.itemType) !== ITEM_TYPE_ERC721) continue;
    const token = String(item.token).toLowerCase();
    if (NFT_COLLECTION_MAP[token]) return { contractAddress: token, tokenId: String(item.identifier) };
  }
  return null;
}

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

async function resolveCurrencyMeta(provider, paymentToken, paymentItemType) {
  if (paymentItemType === ITEM_TYPE_NATIVE) return { symbol: "ETN", decimals: 18 };
  if (!paymentToken || paymentToken === ethers.ZeroAddress.toLowerCase()) return { symbol: "TOKEN", decimals: 18 };

  try {
    const token = new ethers.Contract(paymentToken, ERC20_MIN_ABI, provider);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  } catch (err) {
    console.error("⚠️  Failed to resolve currency metadata:", err.message);
    return { symbol: "TOKEN", decimals: 18 };
  }
}

async function announceSale(provider, resolveDisplayName, { contractAddress, tokenId, seller, buyer, offer, consideration, txHash }) {
  const collection = NFT_COLLECTION_MAP[contractAddress];
  if (!collection) return;

  const payment = sumFungible(consideration);
  if (payment.amountRaw <= 0n) return;

  const [{ symbol, decimals }, sellerDisplay, buyerDisplay] = await Promise.all([
    resolveCurrencyMeta(provider, payment.paymentToken, payment.paymentItemType),
    resolveDisplayName(seller),
    resolveDisplayName(buyer),
  ]);

  const caption =
    `💰 <b>${escapeHtml(collection.name)} Sale</b>\n\n` +
    `Token: <b>#${escapeHtml(tokenId)}</b>\n` +
    `Seller: <a href="${EXPLORER_BASE_URL}/address/${seller}">${escapeHtml(sellerDisplay)}</a>\n` +
    `Buyer: <a href="${EXPLORER_BASE_URL}/address/${buyer}">${escapeHtml(buyerDisplay)}</a>\n` +
    `Price: <b>${escapeHtml(ethers.formatUnits(payment.amountRaw, decimals))} ${escapeHtml(symbol)}</b>\n` +
    `NFT: <a href="${ELECTROSWAP_BASE_URL}/nfts/asset/${contractAddress}/${tokenId}">View NFT</a>\n` +
    `Tx: <a href="${EXPLORER_BASE_URL}/tx/${txHash}">View Transaction</a>`;

  await sendZephyrosMessage(caption, { threadId: NFT_THREAD_ID });
  console.log(`💰 Sale alert sent for ${collection.name} #${tokenId} (tx ${txHash})`);
}

let isPolling = false;

async function poll(provider, resolveDisplayName) {
  if (isPolling) return;
  isPolling = true;

  try {
    const latestBlock = await provider.getBlockNumber();

    const saved = await getState(STATE_KEY);
    let fromBlock = saved?.lastBlock ?? null;

    if (fromBlock == null) {
      fromBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS) - 1;
      console.log(`💰 NFT sale watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock <= fromBlock) return;

    let start = fromBlock + 1;
    while (start <= latestBlock) {
      const end = Math.min(start + MAX_BLOCK_RANGE - 1, latestBlock);
      const logs = await provider.getLogs({ address: SEAPORT_ADDRESS, topics: [ORDER_FULFILLED_TOPIC], fromBlock: start, toBlock: end });

      for (const log of logs) {
        try {
          const parsed = IFACE.parseLog(log);
          const offerer = String(parsed.args.offerer).toLowerCase();
          const recipient = String(parsed.args.recipient).toLowerCase();

          const inOffer = findTrackedErc721(parsed.args.offer);
          const inConsideration = findTrackedErc721(parsed.args.consideration);

          if (inOffer) {
            await announceSale(provider, resolveDisplayName, {
              contractAddress: inOffer.contractAddress,
              tokenId: inOffer.tokenId,
              seller: offerer,
              buyer: recipient,
              consideration: parsed.args.consideration,
              txHash: log.transactionHash,
            });
          } else if (inConsideration) {
            await announceSale(provider, resolveDisplayName, {
              contractAddress: inConsideration.contractAddress,
              tokenId: inConsideration.tokenId,
              seller: recipient,
              buyer: offerer,
              consideration: parsed.args.offer,
              txHash: log.transactionHash,
            });
          }
        } catch (err) {
          console.error("⚠️  Failed to process sale log:", err.message);
        }
      }

      start = end + 1;
    }

    await setState(STATE_KEY, { lastBlock: latestBlock });
  } catch (err) {
    console.error("⚠️  NFT sale watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

export async function startCoreClashNftSaleWatcher() {
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros bot not configured — Core Clash NFT sale watcher disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as marketplaceWatcher.js; this provider now also resolves
  // seller/buyer primary names via primaryNameResolver.js.
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  console.log(`💰 Core Clash NFT sale watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(provider, resolveDisplayName);
  setInterval(() => poll(provider, resolveDisplayName), POLL_INTERVAL_MS);
}
