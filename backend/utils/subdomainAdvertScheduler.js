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

const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7";
// Every deprecated marketplace this app used to point at — a listing on any of them never
// sold/cancelled is still real and still buyable (see useMarketplaceListings.js), so the
// "Marketplace" advert reads all of them, same as the site's own Marketplace page.
const LEGACY_MARKETPLACE_ADDRESSES = [
  process.env.LEGACY_MARKETPLACE_V4_ADDRESS || "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2",
  process.env.LEGACY_MARKETPLACE_V3_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13",
];
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// Same default/override as marketplaceWatcher.js's SITE_URL — every link in these adverts is
// relative to this.
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";
// Caps how many domains/listings get listed by name in a single advert — Telegram messages have
// a ~4096 char limit, and a wall of 50+ lines isn't more persuasive than the top handful plus a
// link to see the rest.
const ADVERT_LIST_LIMIT = 10;

// Symbol/decimals for display only — same 9 tokens src/config.js's own CANDIDATE_PAYMENT_TOKENS
// tracks, duplicated here rather than imported since this backend has no access to the frontend's
// src/ tree (same "fine to drift independently" convention this whole file already follows for
// MARKETPLACE_ABI etc.). Only used to label a domain's price in buildSubnamesAdvert below — never
// used to decide whether a token is actually usable (that's still a real on-chain fact, checked by
// subnameDomainsCache.js itself before a domain/currency ever reaches the cache this reads).
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

const CURRENCY_ROTATION_STATE_KEY = "subnames-currency-rotation";

// Rotates which currency headlines a domain's price in buildSubnamesAdvert when it's priced in
// more than one — without this, a domain priced in both ETN and a token would show ETN in every
// single post forever (see the old "prefer ETN, else whatever it IS priced in" comment this
// replaced), never giving the other currencies it actually accepts any visibility. Advances by 1
// every time this advert is actually sent — buildMessage only runs at send time, and the
// "Subnames" advert is one of three in a daily rotation (see advertScheduler.js), so in practice
// this ticks roughly once a day. Persisted via subdomainAdvertState.js's same getState/setState
// so the rotation survives restarts/redeploys instead of resetting to 0 (which would just mean
// "always show ETN first" — see the ordering below) every boot. Falls back to cycle 0 on any
// read/write failure — a broken rotation is a cosmetic annoyance, not worth failing the advert
// over.
async function nextCurrencyRotationCycle() {
  try {
    const saved = await getState(CURRENCY_ROTATION_STATE_KEY);
    const cycle = Number.isInteger(saved?.cycle) ? saved.cycle : 0;
    await setState(CURRENCY_ROTATION_STATE_KEY, { cycle: cycle + 1 });
    return cycle;
  } catch (err) {
    console.warn("⚠️  Failed to read/advance subnames currency rotation, defaulting to ETN-first:", err.message);
    return 0;
  }
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

  // A domain can be priced in several currencies at once (pricesByCurrency — see
  // subnameDomainsCache.js's own header comment) — this advert only has room for one headline
  // figure per domain. Rather than always defaulting to ETN (which would mean a domain that also
  // accepts, say, USDC never gets to show that in this promo), the headline currency rotates
  // across successive posts — see nextCurrencyRotationCycle above. ETN is still ordered first
  // within each domain's own currency list when present, so cycle 0 (and any brand-new domain
  // with only one currency) shows the same ETN-preferred figure the old single-currency version
  // did; tokens follow in a stable (sorted-by-address) order so the rotation is deterministic
  // rather than jumping around based on on-chain event ordering.
  const cycle = await nextCurrencyRotationCycle();

  const withHeadline = domains.map((d) => {
    const currencies = Object.keys(d.pricesByCurrency || {});
    if (currencies.length === 0) return null;
    const ordered = [
      ...(currencies.includes(ethers.ZeroAddress) ? [ethers.ZeroAddress] : []),
      ...currencies.filter((c) => c !== ethers.ZeroAddress).sort(),
    ];
    const primary = ordered[cycle % ordered.length];
    const isEtn = primary === ethers.ZeroAddress;
    const token = TOKEN_DECIMALS_BY_ADDRESS[primary] || { symbol: "?", decimals: 18 };
    return { ...d, isEtn, headlinePriceWei: d.pricesByCurrency?.[primary], headlineSymbol: isEtn ? "ETN" : token.symbol, headlineDecimals: token.decimals };
  }).filter((d) => d && d.headlinePriceWei != null);

  const sorted = [
    ...withHeadline.filter((d) => d.isEtn).sort((a, b) => (BigInt(a.headlinePriceWei) < BigInt(b.headlinePriceWei) ? -1 : 1)),
    ...withHeadline.filter((d) => !d.isEtn),
  ];
  const shown = sorted.slice(0, ADVERT_LIST_LIMIT);
  const remaining = sorted.length - shown.length;

  const lines = shown.map((d) => {
    const name = `${d.label}.etn`;
    const link = `${SITE_URL}/subnames/${name}`;
    const priceText = d.isEtn
      ? `${formatEtnCompact(d.headlinePriceWei)} ETN`
      : `${ethers.formatUnits(d.headlinePriceWei, d.headlineDecimals)} ${d.headlineSymbol}`;
    return `• [${name}](${link}) — ${priceText}/year`;
  });

  return (
    `🏷️ *Get a Subname*\n\n` +
    `Domains currently selling subnames:\n\n` +
    lines.join("\n") +
    (remaining > 0 ? `\n…and ${remaining} more` : "") +
    `\n\n[Browse All](${SITE_URL})`
  );
}

// nextListingId()/listings() are unchanged getters between V3 and V4 (same selectors), so one
// helper works against either contract instance.
async function getActiveListings(marketplace) {
  const nextId = await marketplace.nextListingId();
  const count = Number(nextId) - 1;
  if (count <= 0) return [];

  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const raw = await mapWithConcurrency(ids, 8, (id) => marketplace.listings(id));
  return raw.filter((l) => l.active);
}

async function buildMarketplaceAdvert(marketplace, legacyMarketplaces, nameWrapper) {
  const emptyMessage = (
    `🏪 *Marketplace*\n\n` +
    `No active listings right now — check back soon, or list a name of your own!\n\n` +
    `[View Marketplace](${SITE_URL}/marketplace)`
  );

  const perSource = await Promise.all([marketplace, ...legacyMarketplaces].map((c) => getActiveListings(c)));
  const active = perSource.flat();

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
  const legacyMarketplaces = LEGACY_MARKETPLACE_ADDRESSES.map((addr) => new ethers.Contract(addr, MARKETPLACE_ABI, provider));
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  const start = createAdvertScheduler({
    getState,
    setState,
    stateKey: "advert-scheduler",
    advertCount: 3,
    buildMessage: async (index) => {
      if (index === 0) return buildActivateAdvert();
      if (index === 1) return buildSubnamesAdvert();
      return buildMarketplaceAdvert(marketplace, legacyMarketplaces, nameWrapper);
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
