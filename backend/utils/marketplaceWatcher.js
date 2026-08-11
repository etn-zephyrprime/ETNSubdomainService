import { ethers } from "ethers";
import { sendTelegramMessage, sendTelegramPhoto, telegramConfigured } from "./telegramNotifier.js";
import { getLastProcessedBlock, setLastProcessedBlock } from "../state/state.js";

// Polls the Marketplace contract for DomainActivated / SubnameRegistered events and posts a
// Telegram notification for each — same chain/contract defaults as the rest of the backend (see
// scripts/backfillNftImages.js), overridable via env for a different deployment.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
// Same bucket the frontend links to (computeNftImageUrl in src/utils/ens.js) and
// scripts/backfillNftImages.js uploads to — same node-keyed object convention.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const POLL_INTERVAL_MS = process.env.WATCHER_POLL_INTERVAL_MS
  ? parseInt(process.env.WATCHER_POLL_INTERVAL_MS, 10)
  : 60000;

// indexed-ness must match src/abis/MarketplaceABI.json exactly, same lesson learned building
// scripts/backfillNftImages.js — get it wrong and ethers silently fails to decode every log.
const MARKETPLACE_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function burnPool() view returns (uint256)",
];
const NAME_WRAPPER_ABI = ["function names(bytes32 node) view returns (bytes)"];

function decodeDnsName(hex) {
  const bytes = ethers.getBytes(hex);
  const labels = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    if (i + 1 + len > bytes.length) break;
    labels.push(ethers.toUtf8String(bytes.slice(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  return labels.join(".");
}

function formatEtn(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(2);
}

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Same construction as src/utils/ens.js's computeSubnode — needed here because
// SubnameRegistered's event args give parentNode + the child's own label, not the child's own
// node, and the NFT image is keyed by the child's node, not the parent's.
function computeSubnode(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

function nftImageUrl(node) {
  if (!R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL.replace(/\/$/, "")}/${node.replace(/^0x/, "")}.png`;
}

// Photo-with-caption when the image is available, otherwise falls back to a plain text message
// — the image genuinely might not exist yet (R2_PUBLIC_URL unset, or a race against the
// frontend's own fire-and-forget /api/generate-nft call still in flight), and that's a normal
// case, not a reason to lose the notification entirely.
async function sendWithImage(node, caption) {
  const imageUrl = nftImageUrl(node);
  if (imageUrl) {
    try {
      await sendTelegramPhoto(imageUrl, caption);
      return;
    } catch (err) {
      console.warn(`⚠️  NFT image not sendable yet (${imageUrl}), falling back to text:`, err.message);
    }
  }
  await sendTelegramMessage(caption);
}

// Same RPC block-range flakiness handled in scripts/backfillNftImages.js's queryLogsChunked —
// duplicated rather than imported since this runs inside the long-lived server process, not a
// one-off script, and the two are fine to drift independently.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, minChunkSize = 50) {
  const events = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      events.push(...chunk);
      start = end + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
      if (isRangeError && chunkSize > minChunkSize) {
        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        continue;
      }
      throw err;
    }
  }
  return events;
}

async function notifyDomainActivated(event, nameWrapper) {
  const { node, payer, feePaid } = event.args;
  const domain = decodeDnsName(await nameWrapper.names(node)) || "(unknown)";
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  await sendWithImage(
    node,
    `🌐 *Domain Activated*\n` +
    `Domain: \`${domain}\`\n` +
    `Buyer: \`${shortAddress(payer)}\`\n` +
    `Price Paid: \`${formatEtn(feePaid)} ETN\`\n` +
    `[View Transaction](${txUrl})`
  );
}

async function notifySubnameRegistered(event, nameWrapper, marketplace) {
  const { parentNode, label, buyer, price, burnAmount } = event.args;
  const domain = decodeDnsName(await nameWrapper.names(parentNode)) || "(unknown)";
  const subname = `${label}.${domain}`;
  const subNode = computeSubnode(parentNode, label);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  // Queried as of this event's own block (not just "latest") so it reads as the running total
  // right after *this* sale specifically, even if a later poll cycle picks up several
  // registrations at once. Goes back to ~0 whenever buyBackAndBurn is called, same as the
  // frontend's BurnPoolCard.
  let burnPoolTotal;
  try {
    burnPoolTotal = await marketplace.burnPool({ blockTag: event.blockNumber });
  } catch (err) {
    console.warn("⚠️  Couldn't read burnPool() total:", err.message);
  }

  await sendWithImage(
    subNode,
    `🏷️ *Subname Registered*\n` +
    `Domain: \`${domain}\`\n` +
    `Subname: \`${subname}\`\n` +
    `Buyer: \`${shortAddress(buyer)}\`\n` +
    `Price Paid: \`${formatEtn(price)} ETN\`\n` +
    `🔥 Added to Burn Pool (20%): \`${formatEtn(burnAmount)} ETN\`\n` +
    (burnPoolTotal !== undefined ? `🔥 Burn Pool Running Total: \`${formatEtn(burnPoolTotal)} ETN\`\n` : "") +
    `[View Transaction](${txUrl})`
  );
}

let isPolling = false;

async function poll(marketplace, nameWrapper) {
  if (isPolling) return; // previous poll still running (e.g. a slow RPC) — skip this tick
  isPolling = true;
  try {
    const latestBlock = await marketplace.runner.getBlockNumber();
    let fromBlock = getLastProcessedBlock();

    if (fromBlock === null) {
      // First ever run — don't replay the contract's whole history into the chat, just start
      // watching from here forward.
      setLastProcessedBlock(latestBlock);
      console.log(`📡 Marketplace watcher initialized at block ${latestBlock}`);
      return;
    }

    if (latestBlock <= fromBlock) return; // nothing new

    const [activated, subnamesRegistered] = await Promise.all([
      queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), fromBlock + 1, latestBlock),
      queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), fromBlock + 1, latestBlock),
    ]);

    // Merge and process in on-chain order, not per-event-type order.
    const events = [...activated, ...subnamesRegistered].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
    );

    for (const event of events) {
      try {
        if (event.eventName === "DomainActivated") {
          await notifyDomainActivated(event, nameWrapper);
        } else if (event.eventName === "SubnameRegistered") {
          await notifySubnameRegistered(event, nameWrapper, marketplace);
        }
      } catch (err) {
        // One bad event (e.g. a transient Telegram API error) shouldn't stop the rest, and
        // shouldn't stop lastProcessedBlock from advancing — this is best-effort notification,
        // not a source of truth.
        console.error(`⚠️  Failed to notify for tx ${event.transactionHash}:`, err.message);
      }
    }

    setLastProcessedBlock(latestBlock);
  } catch (err) {
    console.error("⚠️  Marketplace watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

/**
 * Starts the background poller. No-op (logs and returns) if Telegram isn't configured — this
 * keeps the rest of the backend working exactly as before for anyone who hasn't set it up.
 */
export function startMarketplaceWatcher() {
  if (!telegramConfigured()) {
    console.log("ℹ️  Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — marketplace watcher disabled");
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  console.log(`📡 Marketplace watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(marketplace, nameWrapper); // run once immediately rather than waiting a full interval
  setInterval(() => poll(marketplace, nameWrapper), POLL_INTERVAL_MS);
}
