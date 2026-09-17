import { ethers } from "ethers";
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramDirectMessage, telegramConfigured } from "./telegramNotifier.js";
import { getLastProcessedV6Block, setLastProcessedV6Block, getLastProcessedV5Block, setLastProcessedV5Block, getLastProcessedV4Block, setLastProcessedV4Block, getLastProcessedV3Block, setLastProcessedV3Block } from "../state/state.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";
import { getLinkedChatId } from "./telegramLinkRouter.js";
import { createRpcProvider } from "./rpcProvider.js";

// Polls the Marketplace contract for DomainActivated / SubnameRegistered / ExistingNameListed /
// ListingSold events and posts a Telegram notification for each — same chain/contract defaults
// as the rest of the backend (see scripts/backfillNftImages.js), overridable via env for a
// different deployment.
// PlanetZephyrosSubdomainServiceV6 — same defaults as src/config.js's MARKETPLACE_ADDRESS/
// MARKETPLACE_DEPLOY_BLOCK. Redeployed 2026-09-17 as a SECURITY FIX (registerSubname could
// silently reassign an already-sold subname; see PlanetZephyros's own
// PlanetZephyrosSubdomainServiceV6.sol header comment) — V5, V4, and V3 were all paused the same
// day and stay paused permanently.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15906639;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS — needed to resolve buyer/seller/payer
// addresses to a primary name (see notifyDomainActivated etc. and primaryNameResolver.js).
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
// Same bucket the frontend links to (computeNftImageUrl in src/utils/ens.js) and
// scripts/backfillNftImages.js uploads to — same node-keyed object convention.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
// Posts a Telegram alert, not a live UI update — sub-minute latency was never actually needed
// here, and polling every 60s was a real chunk of this backend's RPC volume (confirmed live via
// Ankr's own per-project request dashboard, after usage this size got a key disabled outright —
// see rpcProvider.js). 5 minutes is still effectively real-time for a notification.
const POLL_INTERVAL_MS = process.env.WATCHER_POLL_INTERVAL_MS
  ? parseInt(process.env.WATCHER_POLL_INTERVAL_MS, 10)
  : 300000;
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
// SubnameRegistered gained an indexed `paymentToken` in V4 (multi-currency subname pricing,
// unchanged shape in V5) — DomainActivated/ExistingNameListed/ListingSold are unchanged from V3.
// DomainActivatedWithToken/erc20BurnPool are V4+ (multi-currency) additions — see
// PlanetZephyrosSubdomainServiceV4.sol/V5.sol's own comments: `burnPool` stays the ETN-only pool
// unchanged from V3, while `erc20BurnPool[token]` is a separate running total per non-ETN
// currency a subname's ever been paid in.
const MARKETPLACE_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event DomainActivatedWithToken(bytes32 indexed node, address indexed payer, address indexed paymentToken, uint256 tokenAmountPaid, uint256 etnEquivalentFee)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, address indexed paymentToken, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ExistingNameListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 price)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function burnPool() view returns (uint256)",
  "function erc20BurnPool(address) view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
// V3's SubnameRegistered has no paymentToken (V3 was ETN-only) — everything else is identical.
const LEGACY_V3_ABI = [
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "event ExistingNameListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 price)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
  "function burnPool() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];

// Every deprecated marketplace this app used to point at, most-recent first — each polled on its
// own separate persisted cursor alongside the current contract, so any residual activity (a
// listing never sold/cancelled being bought/cancelled directly, or the admin flushing a leftover
// burn pool) still gets a Telegram alert instead of going silently unwatched.
const LEGACY_MARKETPLACES = [
  {
    address: process.env.LEGACY_MARKETPLACE_V5_ADDRESS || "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7",
    deployBlock: 15874925,
    abi: MARKETPLACE_ABI,
    getCursor: getLastProcessedV5Block,
    setCursor: setLastProcessedV5Block,
    label: " (legacy V5)",
  },
  {
    address: process.env.LEGACY_MARKETPLACE_V4_ADDRESS || "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2",
    deployBlock: 15873016,
    abi: MARKETPLACE_ABI,
    getCursor: getLastProcessedV4Block,
    setCursor: setLastProcessedV4Block,
    label: " (legacy V4)",
  },
  {
    address: process.env.LEGACY_MARKETPLACE_V3_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13",
    deployBlock: 15207471,
    abi: LEGACY_V3_ABI,
    getCursor: getLastProcessedV3Block,
    setCursor: setLastProcessedV3Block,
    label: " (legacy V3)",
  },
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

// Symbol/decimals for display only — same 9 tokens subdomainAdvertScheduler.js's own
// TOKEN_DECIMALS_BY_ADDRESS tracks, duplicated here per this file's own established
// "small per-file helpers are fine to drift independently" convention (see queryLogsChunked's
// header comment below). Only used to label an amount in a notification — never to decide
// whether a token is actually usable (that's a real on-chain fact the contract itself already
// enforced before any of these events could ever exist).
const TOKEN_DECIMALS_BY_ADDRESS = {
  "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1": { symbol: "BOLT", decimals: 18 },
  "0x309B916b3A90cb3E071697Ea9680e9217A30066f": { symbol: "CORE", decimals: 18 },
  "0xEe432C220273e4F949007B4c1946562826Efa055": { symbol: "DYNO", decimals: 18 },
  "0xc20d02538368D8F7deBeAeB99D9a8b4d4D1DDC1C": { symbol: "PDY", decimals: 18 },
  "0x075533AB8EeC6A6999F07C8bc2f1900eB8312e25": { symbol: "FUGAZI", decimals: 18 },
  "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e": { symbol: "USDC", decimals: 6 },
  "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7": { symbol: "USDT", decimals: 6 },
  "0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131": { symbol: "CLUB", decimals: 18 },
  "0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5": { symbol: "DCNT", decimals: 18 },
};

// Resolves an event's `paymentToken` field to display info. `undefined` covers a legacy V3
// event, which predates multi-currency pricing and never had this field at all — always ETN, same
// as `ethers.ZeroAddress` (V4/V5's own convention for "priced in ETN"). Falls back to a
// "?"/18-decimals placeholder for a genuinely unrecognized token address rather than throwing —
// flagged loudly via console.warn so it's visible, but a notification with an unlabeled amount is
// still better than no notification at all for a real on-chain sale.
function resolveCurrency(paymentToken) {
  if (paymentToken === undefined || paymentToken === ethers.ZeroAddress) {
    return { symbol: "ETN", decimals: 18, isEtn: true, address: ethers.ZeroAddress };
  }
  const known = TOKEN_DECIMALS_BY_ADDRESS[paymentToken];
  if (!known) {
    console.warn(`⚠️  Unrecognized payment token ${paymentToken} — notification will show "?" instead of a real symbol`);
    return { symbol: "?", decimals: 18, isEtn: false, address: paymentToken };
  }
  return { ...known, isEtn: false, address: paymentToken };
}

// listExistingName/buyListing (resale) stayed `payable`-only, ETN-exclusive across V3/V4/V5 —
// only subname registration and activation ever gained multi-currency support (registerSubname/
// activateDomainWithToken) — so notifyNameListed/notifyListingSold below are deliberately left on
// formatEtn rather than resolveCurrency/formatAmount; there's no paymentToken to resolve.
function formatAmount(wei, currency) {
  return `${parseFloat(ethers.formatUnits(wei, currency.decimals)).toFixed(2)} ${currency.symbol}`;
}

// Whether `contract`'s own ABI declares an event named `eventName` — used to skip querying
// DomainActivatedWithToken against a legacy V3 source, whose ABI predates it entirely (querying a
// filter for an event a contract's interface doesn't declare throws, which would otherwise take
// down that source's whole poll via the Promise.all it's grouped into below).
function contractHasEvent(contract, eventName) {
  return contract.interface.fragments.some((f) => f.type === "event" && f.name === eventName);
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

// ERC20 counterpart to notifyDomainActivated above — activateDomainWithToken's own event (V4+
// only, see MARKETPLACE_ABI's comment). Shows the ETN-equivalent fee alongside the actual token
// amount paid since that's the figure everyone's used to seeing for activation cost, and the
// token amount alone doesn't convey that on its own.
async function notifyDomainActivatedWithToken(event, nameWrapper, resolveDisplayName) {
  const { node, payer, paymentToken, tokenAmountPaid, etnEquivalentFee } = event.args;
  const currency = resolveCurrency(paymentToken);
  const domain = decodeDnsName(await nameWrapper.names(node)) || "(unknown)";
  const buyerDisplay = await resolveDisplayName(payer);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  await sendWithImage(
    node,
    `🌐 *Domain Activated*\n` +
    `Domain: \`${domain}\`\n` +
    `Buyer: \`${buyerDisplay}\`\n` +
    `Price Paid: \`${formatAmount(tokenAmountPaid, currency)}\` (≈ ${formatEtn(etnEquivalentFee)} ETN)\n` +
    `[View Transaction](${txUrl})\n` +
    SITE_LINK_LINE
  );
}

async function notifySubnameRegistered(event, nameWrapper, marketplace, resolveDisplayName) {
  const { parentNode, label, buyer, paymentToken, price, burnAmount } = event.args;
  const currency = resolveCurrency(paymentToken);
  const domain = decodeDnsName(await nameWrapper.names(parentNode)) || "(unknown)";
  const subname = `${label}.${domain}`;
  const subNode = computeSubnode(parentNode, label);
  const buyerDisplay = await resolveDisplayName(buyer);
  const txUrl = `${EXPLORER_BASE_URL}/tx/${event.transactionHash}`;

  // Queried as of this event's own block (not just "latest") so it reads as the running total
  // right after *this* sale specifically, even if a later poll cycle picks up several
  // registrations at once. Goes back to ~0 whenever buyBackAndBurn/buyBackAndBurnToken is called,
  // same as the frontend's BurnPoolCard. An ETN sale reads the shared burnPool(); a token sale
  // reads that token's own erc20BurnPool(token) instead — the two are tracked entirely separately
  // on-chain (see MARKETPLACE_ABI's comment above), so mixing them here would be meaningless. A
  // legacy V3 event never has a real paymentToken (see resolveCurrency), so this only ever takes
  // the ETN branch for V3 sales — which is also the only branch its ABI actually supports.
  let burnPoolTotal;
  try {
    burnPoolTotal = currency.isEtn
      ? await marketplace.burnPool({ blockTag: event.blockNumber })
      : await marketplace.erc20BurnPool(currency.address, { blockTag: event.blockNumber });
  } catch (err) {
    console.warn("⚠️  Couldn't read burn pool total:", err.message);
  }

  await sendWithImage(
    subNode,
    `🏷️ *Subname Registered*\n` +
    `Domain: \`${domain}\`\n` +
    `Subname: \`${subname}\`\n` +
    `Buyer: \`${buyerDisplay}\`\n` +
    `Price Paid: \`${formatAmount(price, currency)}\`\n` +
    `🔥 Added to Burn Pool (20%): \`${formatAmount(burnAmount, currency)}\`\n` +
    (burnPoolTotal !== undefined ? `🔥 Burn Pool Running Total: \`${formatAmount(burnPoolTotal, currency)}\`\n` : "") +
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
      `🏷️ *${subname}* just sold for *${formatAmount(price, currency)}*\n\n` +
      `You earned *${formatAmount(event.args.sellerAmount, currency)}* (80%).\n\n` +
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

// Parametrized by contract/deploy-block/cursor getters+setters/log-label so the exact same poll
// logic backs the current contract's watcher and every deprecated contract's own independent poll
// (see startMarketplaceWatcher) — each source gets its own cursor, since each has a different
// deploy block and there's no reason a gap in one's history should affect any other's.
async function pollContract(marketplace, nameWrapper, resolveDisplayName, deployBlock, getCursor, setCursor, logLabel) {
  const latestBlock = await marketplace.runner.getBlockNumber();
  let fromBlock = await getCursor();

  if (fromBlock === null) {
    // No saved state — either a genuine first run, or state was wiped out from under us (see
    // WATCHER_LOOKBACK_BLOCKS above). Look back a bounded window rather than either replaying
    // the whole contract history or skipping straight to "latest" and missing anything.
    fromBlock = Math.max(deployBlock, latestBlock - WATCHER_LOOKBACK_BLOCKS) - 1;
    console.log(`📡 Marketplace watcher${logLabel} initialized — no saved state, looking back to block ${fromBlock + 1}`);
  }

  if (latestBlock <= fromBlock) return; // nothing new

  // DomainActivatedWithToken doesn't exist on a legacy V3 contract's own ABI at all (see
  // MARKETPLACE_ABI's comment) — querying a filter for an event a contract's interface doesn't
  // declare throws, so this is only ever included for a source that actually has it.
  const queries = [
    queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), fromBlock + 1, latestBlock),
    queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), fromBlock + 1, latestBlock),
    queryLogsChunked(marketplace, marketplace.filters.ExistingNameListed(), fromBlock + 1, latestBlock),
    queryLogsChunked(marketplace, marketplace.filters.ListingSold(), fromBlock + 1, latestBlock),
  ];
  const supportsTokenActivation = contractHasEvent(marketplace, "DomainActivatedWithToken");
  if (supportsTokenActivation) {
    queries.push(queryLogsChunked(marketplace, marketplace.filters.DomainActivatedWithToken(), fromBlock + 1, latestBlock));
  }
  const [activated, subnamesRegistered, nameListed, listingSold, activatedWithToken] = await Promise.all(queries);

  // Merge and process in on-chain order, not per-event-type order.
  const events = [...activated, ...subnamesRegistered, ...nameListed, ...listingSold, ...(activatedWithToken || [])].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
  );

  for (const event of events) {
    try {
      if (event.eventName === "DomainActivated") {
        await notifyDomainActivated(event, nameWrapper, resolveDisplayName);
      } else if (event.eventName === "DomainActivatedWithToken") {
        await notifyDomainActivatedWithToken(event, nameWrapper, resolveDisplayName);
      } else if (event.eventName === "SubnameRegistered") {
        await notifySubnameRegistered(event, nameWrapper, marketplace, resolveDisplayName);
      } else if (event.eventName === "ExistingNameListed") {
        await notifyNameListed(event, nameWrapper, resolveDisplayName);
      } else if (event.eventName === "ListingSold") {
        await notifyListingSold(event, nameWrapper, marketplace, resolveDisplayName);
      }
    } catch (err) {
      // One bad event (e.g. a transient Telegram API error) shouldn't stop the rest, and
      // shouldn't stop the cursor from advancing — this is best-effort notification, not a
      // source of truth.
      console.error(`⚠️  Failed to notify for tx ${event.transactionHash}:`, err.message);
    }
  }

  await setCursor(latestBlock);
}

// Guards each source's poll independently by address, so a slow poll of one contract overlapping
// with itself on the next tick never blocks (or gets blocked by) any other source's own poll.
const pollingGuards = new Map(); // address -> boolean

async function guardedPoll(address, marketplace, nameWrapper, resolveDisplayName, deployBlock, getCursor, setCursor, logLabel) {
  if (pollingGuards.get(address)) return;
  pollingGuards.set(address, true);
  try {
    await pollContract(marketplace, nameWrapper, resolveDisplayName, deployBlock, getCursor, setCursor, logLabel);
  } catch (err) {
    console.error(`⚠️  Marketplace watcher poll failed${logLabel}:`, err.message);
  } finally {
    pollingGuards.set(address, false);
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
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  const sources = [
    { address: MARKETPLACE_ADDRESS, deployBlock: MARKETPLACE_DEPLOY_BLOCK, contract: marketplace, getCursor: getLastProcessedV6Block, setCursor: setLastProcessedV6Block, label: "" },
    ...LEGACY_MARKETPLACES.map((m) => ({
      address: m.address,
      deployBlock: m.deployBlock,
      contract: new ethers.Contract(m.address, m.abi, provider),
      getCursor: m.getCursor,
      setCursor: m.setCursor,
      label: m.label,
    })),
  ];

  const runAllPolls = () => {
    for (const s of sources) guardedPoll(s.address, s.contract, nameWrapper, resolveDisplayName, s.deployBlock, s.getCursor, s.setCursor, s.label);
  };

  console.log(`📡 Marketplace watcher started (polling every ${POLL_INTERVAL_MS / 1000}s, ${sources.length} source(s): current + every deprecated marketplace)`);
  runAllPolls(); // run once immediately rather than waiting a full interval
  setInterval(runAllPolls, POLL_INTERVAL_MS);
}
