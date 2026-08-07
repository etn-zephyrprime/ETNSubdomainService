// Chain — Electroneum MAINNET (52014). PlanetZephyrosSubdomainNameService is now deployed here
// too; testnet (5201420) is reachable via the env var overrides below if needed.
export const CHAIN_ID = import.meta.env.VITE_CHAIN_ID ? parseInt(import.meta.env.VITE_CHAIN_ID, 10) : 52014;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.ankr.com/electroneum";
export const EXPLORER_BASE_URL = import.meta.env.VITE_EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";

// Contract addresses
// Redeployed 2026-08-07 as PlanetZephyrosSubdomainNameService (renamed from
// PlanetZephyrosNameMarketplace) to fix activateDomain, which could never succeed for a name
// registered directly through Electroneum and never wrapped — exactly the "Retro Register" case
// it exists for — because every check inside it only ever read NameWrapper data (all-zero for an
// unwrapped name). The prior deployment (0x1191C7c0558F52a7282C00Bc477aA16187C1fE64, block
// 15188489) is left live on-chain with the old bug, not pointed at anymore.
export const MARKETPLACE_ADDRESS = import.meta.env.VITE_MARKETPLACE_ADDRESS || "0x775c9BF1516811349915fC50E471875252Bb5Ef3";
// Block MARKETPLACE_ADDRESS was deployed at — the public RPC rejects eth_getLogs queries with an
// unscoped fromBlock ("Block range is too large"), so log scans (e.g. discovering which domains
// have a subname price set) start here instead of from genesis. Must be updated alongside
// MARKETPLACE_ADDRESS on every redeploy.
export const MARKETPLACE_DEPLOY_BLOCK = import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15201936;
export const REGISTRAR_CONTROLLER_ADDRESS = import.meta.env.VITE_REGISTRAR_CONTROLLER_ADDRESS || "0x5cD5CEFDc5925cA6A9A38D2AA810d5aeD360b21C";
export const BASE_REGISTRAR_ADDRESS = import.meta.env.VITE_BASE_REGISTRAR_ADDRESS || "0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59";
// registerName() (via this app) always wraps — the raw ERC721 ends up owned by NameWrapper
// itself, so ownership lookups for names registered *through this app* must query
// NameWrapper.ownerOf(node), not BaseRegistrar.ownerOf(tokenId) (which just returns
// NameWrapper's own address post-wrap). Names registered directly through Electroneum, outside
// this app, are NOT wrapped — see useRenewal.js's getOwner(), which falls back to
// BaseRegistrar.ownerOf(tokenId) for exactly that case.
export const NAME_WRAPPER_ADDRESS = import.meta.env.VITE_NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";

// namehash("etn") — Electroneum's ENS fork uses its own TLD, not "eth". Confirmed on-chain:
// ENSRegistry.owner(this node) returns exactly BaseRegistrarImplementation's address. Same value
// on every chain — it's just a hash, not a deployed address.
export const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

// ReverseRegistrar — lets a wallet set/read its primary ("reverse") name via setName /
// setNameForAddr. Electroneum TESTNET uses a different address
// (0x470680Df59dB243409F67ec7EaC78D8e6f834047) — override via the env var if you point this app
// at testnet.
export const REVERSE_REGISTRAR_ADDRESS =
  import.meta.env.VITE_REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";

// Default renewal duration — 1 year flat, matching the real registrar's own year-based pricing.
export const DEFAULT_DURATION_SECONDS = 365 * 24 * 60 * 60;

// Preset registration lengths, priced the same way the real ETHRegistrarController does — a flat
// per-second rate, so N years just costs N times the 1-year price.
const YEAR_SECONDS = 365 * 24 * 60 * 60;
export const DURATION_OPTIONS = [
  { label: "1 year", seconds: YEAR_SECONDS },
  { label: "2 years", seconds: 2 * YEAR_SECONDS },
  { label: "3 years", seconds: 3 * YEAR_SECONDS },
  { label: "5 years", seconds: 5 * YEAR_SECONDS },
];

// UI-only floor on what a domain owner can set their subname price to — not enforced on-chain,
// just keeps the "Set Price" form from accepting an accidentally-tiny value (e.g. a misplaced
// decimal). Setting price to 0 (turning sales off entirely) is exempt from this minimum.
export const MIN_SUBNAME_PRICE_PER_YEAR_ETN = "1000";

// Reown
export const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID || "146ee334d324044083b6427d4bbf9202";

// Backend — NFT image generation + R2 upload (see backend/index.js)
export const BACKEND_IMAGE_URL = import.meta.env.VITE_BACKEND_IMAGE_URL || "https://electroneumnameservice.onrender.com";
