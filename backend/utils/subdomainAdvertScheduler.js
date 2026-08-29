// backend/utils/subdomainAdvertScheduler.js
//
// Posts one of three rotating promo messages to this repo's own bot/chat (TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID / TELEGRAM_MESSAGE_THREAD_ID — same "Subdomain Name Service" topic
// marketplaceWatcher.js already posts activity into) once per day, at a randomized time, via
// advertScheduler.js — same engine and scheduling guarantees as coreClashAdvertScheduler.js,
// just a 1-day cycle instead of 3.
//
// Two of the three adverts are dynamic — built fresh at send time, not baked in like the Core
// Clash bot's static rotation:
//   - "Get a Subname": every domain currently selling subnames + its price, read from the
//     already-published subnameDomainsCache.js cache (same R2 object the frontend's
//     SubnameSearch screen fetches) rather than re-scanning on-chain here too.
//   - "Marketplace": current active listings, read live via nextListingId()/listings() — same
//     approach as marketplaceSellersCache.js, but that cache only publishes seller *names*, not
//     the listing details themselves (deliberately — see its header comment), so this reads them
//     directly instead of depending on a cache that doesn't carry what it needs.
// Both link into deep-link routes App.jsx already supports (/subnames/<parent>, /marketplace) —
// see App.jsx's own comment for why those don't gate on wallet connection.
import { ethers } from "ethers";
import { sendTelegramMessage, telegramConfigured } from "./telegramNotifier.js";
import { getSubnameDomainsCache } from "../state/subnameDomainsState.js";
import { getState, setState } from "../state/subdomainAdvertState.js";
import { createAdvertScheduler } from "./advertScheduler.js";
import { createRpcProvider } from "./rpcProvider.js";

const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same default/override as marketplaceWatcher.js's SITE_URL — every link in these adverts is
// relative to this.
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";
// Caps how many domains/listings get listed by name in a single advert — Telegram messages have
// a ~4096 char limit, and a wall of 50+ lines isn't more persuasive than the top handful plus a
// link to see the rest.
const ADVERT_LIST_LIMIT = 10;

const MARKETPLACE_ABI = [
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool active)",
];
const NAME_WRAPPER_ABI = ["function names(bytes32 node) view returns (bytes)"];

// Same as marketplaceWatcher.js's own copies — duplicated per this codebase's established
// "small per-file helpers are fine to drift independently" convention.
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
  return parseFloat(ethers.formatEther(wei)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Subname prices only (buildSubnamesAdvert) — a wall of "1,250.00 ETN/year" lines reads as
// noisier/less scannable in a promo message than "1.25k ETN/year", and cents never matter at
// these prices anyway. Marketplace listing prices (buildMarketplaceAdvert) intentionally keep
// full precision via formatEtn above — a one-off name sale price isn't the same kind of "round
// number, skim it fast" figure a per-year rate is.
function formatEtnCompact(wei) {
  const value = parseFloat(ethers.formatEther(wei));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value).toLowerCase();
}

function tokenIdToNode(tokenId) {
  return ethers.toBeHex(tokenId, 32);
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

function buildActivateAdvert() {
  return (
    `🌐 *Activate Your .etn Domain*\n\n` +
    `Activate your own \`.etn\` domain on the ETN Subdomain Service and start renting out subnames under it — you keep *80%* of every subname sale, forever.\n\n` +
    `[ETN Subdomain Service](${SITE_URL})`
  );
}

async function buildSubnamesAdvert() {
  const cache = await getSubnameDomainsCache();
  const domains = Array.isArray(cache?.domains) ? cache.domains : [];

  if (domains.length === 0) {
    return (
      `🏷️ *Get a Subname*\n\n` +
      `No domains are selling subnames yet — activate yours and be the first!\n\n` +
      `[ETN Subdomain Service](${SITE_URL})`
    );
  }

  const sorted = [...domains].sort((a, b) => (BigInt(a.pricePerYear) < BigInt(b.pricePerYear) ? -1 : 1));
  const shown = sorted.slice(0, ADVERT_LIST_LIMIT);
  const remaining = sorted.length - shown.length;

  const lines = shown.map((d) => {
    const name = `${d.label}.etn`;
    const link = `${SITE_URL}/subnames/${name}`;
    return `• [${name}](${link}) — ${formatEtnCompact(d.pricePerYear)} ETN/year`;
  });

  return (
    `🏷️ *Get a Subname*\n\n` +
    `Domains currently selling subnames:\n\n` +
    lines.join("\n") +
    (remaining > 0 ? `\n…and ${remaining} more` : "") +
    `\n\n[Browse All](${SITE_URL})`
  );
}

async function buildMarketplaceAdvert(marketplace, nameWrapper) {
  const nextId = await marketplace.nextListingId();
  const count = Number(nextId) - 1;

  const emptyMessage = (
    `🏪 *Marketplace*\n\n` +
    `No active listings right now — check back soon, or list a name of your own!\n\n` +
    `[View Marketplace](${SITE_URL}/marketplace)`
  );

  if (count <= 0) return emptyMessage;

  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const raw = await mapWithConcurrency(ids, 8, (id) => marketplace.listings(id));
  const active = raw.filter((l) => l.active);

  if (active.length === 0) return emptyMessage;

  const withNames = await mapWithConcurrency(active, 8, async (listing) => {
    const node = tokenIdToNode(listing.tokenId);
    let name;
    try {
      name = decodeDnsName(await nameWrapper.names(node)) || null;
    } catch (err) {
      console.warn(`⚠️  Failed to decode name for listing tokenId ${listing.tokenId}:`, err.message);
      name = null;
    }
    return { name, price: listing.price };
  });

  const sorted = withNames.filter((l) => l.name).sort((a, b) => (a.price < b.price ? -1 : 1));
  const shown = sorted.slice(0, ADVERT_LIST_LIMIT);
  const remaining = sorted.length - shown.length;

  if (shown.length === 0) return emptyMessage;

  const lines = shown.map((l) => `• \`${l.name}\` — ${formatEtn(l.price)} ETN`);

  return (
    `🏪 *Marketplace*\n\n` +
    `Names currently for sale:\n\n` +
    lines.join("\n") +
    (remaining > 0 ? `\n…and ${remaining} more` : "") +
    `\n\n[View Marketplace](${SITE_URL}/marketplace)`
  );
}

export async function startSubdomainAdvertScheduler() {
  if (!telegramConfigured()) {
    console.log("ℹ️  Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — subdomain advert scheduler disabled");
    return;
  }

  const provider = createRpcProvider({ batchMaxCount: 1 });
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  const start = createAdvertScheduler({
    getState,
    setState,
    stateKey: "advert-scheduler",
    advertCount: 3,
    buildMessage: async (index) => {
      if (index === 0) return buildActivateAdvert();
      if (index === 1) return buildSubnamesAdvert();
      return buildMarketplaceAdvert(marketplace, nameWrapper);
    },
    sendMessage: (text) => sendTelegramMessage(text),
    isConfigured: telegramConfigured,
    notConfiguredLog: "ℹ️  Telegram not configured — subdomain advert scheduler disabled",
    startedLog: "📢 Subdomain advert scheduler",
    cycleDays: 1,
    minGapHours: 3,
  });

  await start();
}
