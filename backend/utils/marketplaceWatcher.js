import { ethers } from "ethers";
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramDirectMessage, telegramConfigured } from "./telegramNotifier.js";
import { getLastProcessedBlock, setLastProcessedBlock } from "../state/state.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";
import { getLinkedChatId } from "./telegramLinkRouter.js";

// Polls the Marketplace contract for DomainActivated / SubnameRegistered / ExistingNameListed /
// ListingSold events and posts a Telegram notification for each — same chain/contract defaults
// as the rest of the backend (see scripts/backfillNftImages.js), overridable via env for a
// different deployment.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15207471;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS — needed to resolve buyer/seller/payer
// addresses to a primary name (see notifyDomainActivated etc. and primaryNameResolver.js).
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
// Same bucket the frontend links to (computeNftImageUrl in src/utils/ens.js) and
// scripts/backfillNftImages.js uploads to — same node-keyed object convention.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const POLL_INTERVAL_MS = process.env.WATCHER_POLL_INTERVAL_MS
  ? parseInt(process.env.WATCHER_POLL_INTERVAL_MS, 10)
  : 60000;
// How far back to look when there's no saved lastProcessedBlock — covers both the genuine first
// run AND, critically, every cold start on a host with ephemeral storage (e.g. Render's free
// tier wipes local disk — including state/data/state.json — on every spin-down/spin-up cycle).
// Without this, a registration that wakes a sleeping instance via its own fire-and-forget
// /api/generate-nft call would find no saved state, "start watching from now", and miss the
// exact event that woke it up, since that event is already in the past by the time this runs.
// ~5s/block on this chain -> 50,000 blocks is ~3 days, generous enough for a quiet weekend on a
// low-traffic instance without replaying the contract's entire history on a truly fresh deploy.
const WATCHER_LOOKBACK_BLOCKS = process.env.WATCHER_LOOKBACK_BLOCKS
  ? parseInt(process.env.WATCHER_LOOKBACK_BLOCKS, 10)
  : 50000;
// Appended to every notification so readers can click straight through to the marketplace.
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";
const SITE_LINK_LINE = `[Active Domain or Register Subnames Here](${SITE_URL})`;

// indexed-ness must match src/abis/MarketplaceABI.json exactly, same lesson learned building
// scripts/backfillNftImages.js — get it wrong and ethers silently fails to decode every log.
const MARKETPLACE_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ExistingNameListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 price)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function burnPool() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
const NAME_WRAPPER_ABI = [
  "function names(bytes32 node) view returns (bytes)",
  "function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)",
];

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

// Same construction as src/utils/ens.js's computeSubnode — needed here because
// SubnameRegistered's event args give parentNode + the child's own label, not the child's own
// node, and the NFT image is keyed by the child's node, not the parent's.
function computeSubnode(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

// A listing's tokenId is just its node cast to uint256 — same convention NameWrapper uses
// everywhere else in this app (see src/hooks/useMarketplaceListings.js's identical conversion).
// Works for either a top-level name's node or a subname's, since listExistingName doesn't
// distinguish between them.
function tokenIdToNode(tokenId) {
  return ethers.toBeHex(tokenId, 32);
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

// DMs `address` directly if (and only if) it's linked its Telegram via telegramLinkRouter.js —
// on top of, never instead of, the public channel post every notify* function below already
// makes. Best-effort: sendTelegramDirectMessage already swallows its own failures (a blocked bot,
// a bad chat id) so one owner's undeliverable DM never affects the channel post or any other
// owner's DM.
async function notifyOwnerDirect(address, text) {
  try {
    const chatId = await getLinkedChatId(address);
    if (chatId) await sendTelegramDirectMessage(chatId, text);
  } catch (err) {
    console.warn(`⚠️  Failed to send personal alert to ${address}:`, err.message);
  }
}

async function notifyDomainActivated(event, nameWrapper, resolveDisplayName) {
  const { node, payer, feePaid } = event.args;
  const domain = decodeDnsName(await nameWrapper.names(node)) || "(unknown)";
  const buyerDisplay = await resolveDisplayName(payer);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  await sendWithImage(
    node,
    `🌐 *Domain Activated*\n` +
    `Domain: \`${domain}\`\n` +
    `Buyer: \`${buyerDisplay}\`\n` +
    `Price Paid: \`${formatEtn(feePaid)} ETN\`\n` +
    `[View Transaction](${txUrl})\n` +
    SITE_LINK_LINE
  );
}

async function notifySubnameRegistered(event, nameWrapper, marketplace, resolveDisplayName) {
  const { parentNode, label, buyer, price, burnAmount } = event.args;
  const domain = decodeDnsName(await nameWrapper.names(parentNode)) || "(unknown)";
  const subname = `${label}.${domain}`;
  const subNode = computeSubnode(parentNode, label);
  const buyerDisplay = await resolveDisplayName(buyer);
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
    `Buyer: \`${buyerDisplay}\`\n` +
    `Price Paid: \`${formatEtn(price)} ETN\`\n` +
    `🔥 Added to Burn Pool (20%): \`${formatEtn(burnAmount)} ETN\`\n` +
    (burnPoolTotal !== undefined ? `🔥 Burn Pool Running Total: \`${formatEtn(burnPoolTotal)} ETN\`\n` : "") +
    `[View Transaction](${txUrl})\n` +
    SITE_LINK_LINE
  );

  // The seller here is the parent domain's owner (they set the price, they earn 80% — see
  // sellerAmount, unused above only because the channel message already derives it from price),
  // not the buyer — a personal DM about a sale should go to whoever actually got paid.
  try {
    const parentData = await nameWrapper.getData(parentNode);
    await notifyOwnerDirect(
      parentData.owner,
      `🏷️ *${subname}* just sold for *${formatEtn(price)} ETN*\n\n` +
      `You earned *${formatEtn(event.args.sellerAmount)} ETN* (80%).\n\n` +
      `[View Transaction](${txUrl})`
    );
  } catch (err) {
    console.warn(`⚠️  Couldn't resolve parent domain owner for personal alert:`, err.message);
  }
}

async function notifyNameListed(event, nameWrapper, resolveDisplayName) {
  const { seller, tokenId, price } = event.args;
  const node = tokenIdToNode(tokenId);
  const name = decodeDnsName(await nameWrapper.names(node)) || "(unknown)";
  const sellerDisplay = await resolveDisplayName(seller);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  await sendWithImage(
    node,
    `🏪 *Name Listed for Resale*\n` +
    `Name: \`${name}\`\n` +
    `Seller: \`${sellerDisplay}\`\n` +
    `Price: \`${formatEtn(price)} ETN\`\n` +
    `[View Transaction](${txUrl})\n` +
    SITE_LINK_LINE
  );
}

async function notifyListingSold(event, nameWrapper, marketplace, resolveDisplayName) {
  const { buyer, seller, price, sellerAmount, burnAmount } = event.args;
  // ListingSold doesn't carry tokenId itself — re-read the listing by its id for the node, same
  // way ExistingNameListed's own listener resolves a name. Queried as of this event's block so a
  // once-active listing already flipped inactive by a later poll still resolves correctly.
  const listing = await marketplace.listings(event.args.listingId, { blockTag: event.blockNumber });
  const node = tokenIdToNode(listing.tokenId);
  const name = decodeDnsName(await nameWrapper.names(node)) || "(unknown)";
  const [sellerDisplay, buyerDisplay] = await Promise.all([resolveDisplayName(seller), resolveDisplayName(buyer)]);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  let burnPoolTotal;
  try {
    burnPoolTotal = await marketplace.burnPool({ blockTag: event.blockNumber });
  } catch (err) {
    console.warn("⚠️  Couldn't read burnPool() total:", err.message);
  }

  await sendWithImage(
    node,
    `💰 *Name Sold*\n` +
    `Name: \`${name}\`\n` +
    `Seller: \`${sellerDisplay}\`\n` +
    `Buyer: \`${buyerDisplay}\`\n` +
    `Price Paid: \`${formatEtn(price)} ETN\`\n` +
    `🔥 Added to Burn Pool (20%): \`${formatEtn(burnAmount)} ETN\`\n` +
    (burnPoolTotal !== undefined ? `🔥 Burn Pool Running Total: \`${formatEtn(burnPoolTotal)} ETN\`\n` : "") +
    `[View Transaction](${txUrl})\n` +
    SITE_LINK_LINE
  );

  await notifyOwnerDirect(
    seller,
    `💰 *${name}* just sold for *${formatEtn(price)} ETN*\n\n` +
    `You received *${formatEtn(sellerAmount)} ETN* (80%).\n\n` +
    `[View Transaction](${txUrl})`
  );
}

let isPolling = false;

async function poll(marketplace, nameWrapper, resolveDisplayName) {
  if (isPolling) return; // previous poll still running (e.g. a slow RPC) — skip this tick
  isPolling = true;
  try {
    const latestBlock = await marketplace.runner.getBlockNumber();
    let fromBlock = await getLastProcessedBlock();

    if (fromBlock === null) {
      // No saved state — either a genuine first run, or state was wiped out from under us (see
      // WATCHER_LOOKBACK_BLOCKS above). Look back a bounded window rather than either replaying
      // the whole contract history or skipping straight to "latest" and missing anything.
      fromBlock = Math.max(MARKETPLACE_DEPLOY_BLOCK, latestBlock - WATCHER_LOOKBACK_BLOCKS) - 1;
      console.log(`📡 Marketplace watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock <= fromBlock) return; // nothing new

    const [activated, subnamesRegistered, nameListed, listingSold] = await Promise.all([
      queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), fromBlock + 1, latestBlock),
      queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), fromBlock + 1, latestBlock),
      queryLogsChunked(marketplace, marketplace.filters.ExistingNameListed(), fromBlock + 1, latestBlock),
      queryLogsChunked(marketplace, marketplace.filters.ListingSold(), fromBlock + 1, latestBlock),
    ]);

    // Merge and process in on-chain order, not per-event-type order.
    const events = [...activated, ...subnamesRegistered, ...nameListed, ...listingSold].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
    );

    for (const event of events) {
      try {
        if (event.eventName === "DomainActivated") {
          await notifyDomainActivated(event, nameWrapper, resolveDisplayName);
        } else if (event.eventName === "SubnameRegistered") {
          await notifySubnameRegistered(event, nameWrapper, marketplace, resolveDisplayName);
        } else if (event.eventName === "ExistingNameListed") {
          await notifyNameListed(event, nameWrapper, resolveDisplayName);
        } else if (event.eventName === "ListingSold") {
          await notifyListingSold(event, nameWrapper, marketplace, resolveDisplayName);
        }
      } catch (err) {
        // One bad event (e.g. a transient Telegram API error) shouldn't stop the rest, and
        // shouldn't stop lastProcessedBlock from advancing — this is best-effort notification,
        // not a source of truth.
        console.error(`⚠️  Failed to notify for tx ${event.transactionHash}:`, err.message);
      }
    }

    await setLastProcessedBlock(latestBlock);
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

  // batchMaxCount: 1 — same fix as activatedDomainsCache.js/marketplaceSellersCache.js; this
  // provider now also resolves buyer/seller/payer primary names via primaryNameResolver.js.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  console.log(`📡 Marketplace watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(marketplace, nameWrapper, resolveDisplayName); // run once immediately rather than waiting a full interval
  setInterval(() => poll(marketplace, nameWrapper, resolveDisplayName), POLL_INTERVAL_MS);
}
