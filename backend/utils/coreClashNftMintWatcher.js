// backend/utils/coreClashNftMintWatcher.js
//
// Ported from CoreClashGame/backend/nftMintListener.js. Watches Transfer(from=0x0, ...) events
// across all four Core Clash NFT collections and posts a Telegram alert for each mint.
//
// NOT ported: attaching the minted NFT's image. The original waited on (and could trigger)
// CoreClashGame's generateMapping()/IPFS-fetch pipeline to have the image cached locally before
// sending a photo message — a hard dependency on that repo's own metadata cache that doesn't
// make sense to drag into an unrelated service. This posts a text alert with a link to view the
// NFT instead; CoreClashGame's own metadata-cache generation is unaffected and keeps working on
// its own schedule.
import { ethers } from "ethers";
import { getState, setState } from "../state/coreClashState.js";
import { sendZephyrosMessage, escapeHtml, shortAddr, zephyrosBotConfigured, NFT_THREAD_ID } from "./coreClashTelegram.js";
import { RPC_URL, EXPLORER_BASE_URL, ELECTROSWAP_BASE_URL, NFT_COLLECTIONS, NFT_COLLECTION_MAP, POLL_INTERVAL_MS, LOOKBACK_BLOCKS } from "./coreClashConfig.js";

const STATE_KEY = "nft-mint-watcher";
const MAX_BLOCK_RANGE = 500;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC721_IFACE = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);

function tokenUrl(contractAddress, tokenId) {
  return `${ELECTROSWAP_BASE_URL}/nfts/asset/${contractAddress}/${tokenId}`;
}

let isPolling = false;

async function poll(provider) {
  if (isPolling) return;
  isPolling = true;

  try {
    const latestBlock = await provider.getBlockNumber();

    const saved = await getState(STATE_KEY);
    let fromBlock = saved?.lastBlock ?? null;

    if (fromBlock == null) {
      fromBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS) - 1;
      console.log(`🧬 NFT mint watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock <= fromBlock) return;

    let start = fromBlock + 1;
    while (start <= latestBlock) {
      const end = Math.min(start + MAX_BLOCK_RANGE - 1, latestBlock);
      const logs = await provider.getLogs({
        address: NFT_COLLECTIONS.map((c) => c.address),
        topics: [TRANSFER_TOPIC],
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        try {
          const parsed = ERC721_IFACE.parseLog(log);
          const from = String(parsed.args.from).toLowerCase();
          if (from !== ethers.ZeroAddress.toLowerCase()) continue; // not a mint

          const contractAddress = String(log.address).toLowerCase();
          const collection = NFT_COLLECTION_MAP[contractAddress];
          if (!collection) continue;

          const tokenId = String(parsed.args.tokenId);
          let minter = String(parsed.args.to).toLowerCase();

          try {
            const tx = await provider.getTransaction(log.transactionHash);
            if (tx?.from) minter = String(tx.from).toLowerCase();
          } catch (err) {
            console.warn(`⚠️  Failed to fetch tx sender for ${log.transactionHash}:`, err.message);
          }

          const caption =
            `🧬 <b>${escapeHtml(collection.name)} Mint</b>\n\n` +
            `Token: <b>#${escapeHtml(tokenId)}</b>\n` +
            `Collector: <a href="${EXPLORER_BASE_URL}/address/${minter}">${escapeHtml(shortAddr(minter))}</a>\n` +
            `NFT: <a href="${tokenUrl(contractAddress, tokenId)}">View NFT</a>\n` +
            `Tx: <a href="${EXPLORER_BASE_URL}/tx/${log.transactionHash}">View Transaction</a>`;

          await sendZephyrosMessage(caption, { threadId: NFT_THREAD_ID });
          console.log(`🧬 Mint alert sent for ${collection.name} #${tokenId} (tx ${log.transactionHash})`);
        } catch (err) {
          console.error("⚠️  Failed to process mint log:", err.message);
        }
      }

      start = end + 1;
    }

    await setState(STATE_KEY, { lastBlock: latestBlock });
  } catch (err) {
    console.error("⚠️  NFT mint watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

export async function startCoreClashNftMintWatcher() {
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros bot not configured — Core Clash NFT mint watcher disabled");
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  console.log(`🧬 Core Clash NFT mint watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(provider);
  setInterval(() => poll(provider), POLL_INTERVAL_MS);
}
