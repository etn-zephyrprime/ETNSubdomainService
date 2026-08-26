// backend/utils/coreClashConfig.js
//
// Shared constants for the Core Clash watchers (coreClash*.js) ported over from
// etn-zephyrprime/CoreClashGame. That backend runs on Render's free tier, which spins down
// after ~15 min idle — CoreClashGame's own background listeners (burn/swap/NFT-mint/NFT-sale
// watchers, the advert scheduler, and the CORE drip bot) only run while that instance happens to
// be awake, so they were silently going stale for hours at a time. Moving them here — a service
// already built around watchers that survive Render's free tier via R2-backed state
// (see state.js) — fixes that. See individual coreClash*.js files for each one.
//
// Every value here has the same default CoreClashGame itself uses; override via env if you ever
// point this at a different deployment.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const ELECTROSWAP_BASE_URL = process.env.ELECTROSWAP_BASE_URL || "https://app.electroswap.io";
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS — these bots trade Core Clash NFTs and
// CORE tokens, not domains, but traders/buyers/sellers are still Electroneum wallets that may
// have set a primary .etn name, so it's resolved the same way marketplaceWatcher.js's domain
// notifications do (see primaryNameResolver.js).
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";

// Same contracts CoreClashGame's backend/config.js and backend/nftConfig.js hardcode.
const CORE_TOKEN_ADDRESS = process.env.CORE_TOKEN_ADDRESS;
const VKIN_CONTRACT_ADDRESS = process.env.VKIN_CONTRACT_ADDRESS || "0x3fc7665B1F6033FF901405CdDF31C2E04B8A2AB4";
const VQLE_CONTRACT_ADDRESS = process.env.VQLE_CONTRACT_ADDRESS || "0x8cFBB04c54d35e2e8471Ad9040D40D73C08136f0";
const SCIONS_CONTRACT_ADDRESS = process.env.SCIONS_CONTRACT_ADDRESS || "0xAc620b1A3dE23F4EB0A69663613baBf73F6C535D";
const EVG_CONTRACT_ADDRESS = process.env.EVG_CONTRACT_ADDRESS || "0x5C81a5609EaeEF7962F1D089D6343F9790387901";

const NFT_COLLECTIONS = [
  { key: "VKIN", name: "Verdant Kin", address: VKIN_CONTRACT_ADDRESS.toLowerCase() },
  { key: "VQLE", name: "Verdant Queen", address: VQLE_CONTRACT_ADDRESS.toLowerCase() },
  { key: "SCIONS", name: "Aether Scions", address: SCIONS_CONTRACT_ADDRESS.toLowerCase() },
  { key: "EVG", name: "Guardians of Erevos", address: EVG_CONTRACT_ADDRESS.toLowerCase() },
];
const NFT_COLLECTION_MAP = Object.fromEntries(NFT_COLLECTIONS.map((c) => [c.address, c]));

// The only pool CoreClashGame's swapsConfig.js actually has live (every other tracked token in
// that file is commented out) — CORE/WETN on the "UNIV2"-style router. See
// coreClashSwapWatcher.js's file comment for why this is a purpose-built single-pool watcher
// rather than a port of swapListener.js's general multi-token/multi-DEX engine.
const CORE_WETN_POOL_ADDRESS = process.env.CORE_WETN_POOL_ADDRESS || "0xc3FE6f98765493aB62AD87C9B5022Ff2FAA2e98D";
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

// Seaport, watched by nftMarketplaceListener.js for sales of any tracked collection.
const SEAPORT_ADDRESS = (process.env.SEAPORT_ADDRESS || "0x678748317e7fD5B7699D07e666087608B401cbFd").toLowerCase();

// dripABI.json's drip() contract — CoreClashGame/backend/config.js hardcodes the same address.
const DRIP_FUNDER_ADDRESS = process.env.DRIP_FUNDER_ADDRESS || "0x5c13dfF13885FbEc61207d52F992c55a5aa1908d";

const POLL_INTERVAL_MS = process.env.COREBOT_POLL_INTERVAL_MS
  ? parseInt(process.env.COREBOT_POLL_INTERVAL_MS, 10)
  : 60000;

// Same reasoning as marketplaceWatcher.js's WATCHER_LOOKBACK_BLOCKS: how far back to scan when
// there's no saved cursor (first run, or R2 unreachable) — bounded so a cold start doesn't
// replay the contract's entire history, generous enough to cover a quiet weekend.
const LOOKBACK_BLOCKS = process.env.COREBOT_LOOKBACK_BLOCKS
  ? parseInt(process.env.COREBOT_LOOKBACK_BLOCKS, 10)
  : 50000;

export {
  RPC_URL,
  EXPLORER_BASE_URL,
  ELECTROSWAP_BASE_URL,
  REVERSE_REGISTRAR_ADDRESS,
  CORE_TOKEN_ADDRESS,
  NFT_COLLECTIONS,
  NFT_COLLECTION_MAP,
  CORE_WETN_POOL_ADDRESS,
  WETN_ADDRESS,
  SEAPORT_ADDRESS,
  DRIP_FUNDER_ADDRESS,
  POLL_INTERVAL_MS,
  LOOKBACK_BLOCKS,
};
