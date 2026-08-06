// Chain — Electroneum Testnet (PlanetZephyrosNameMarketplace isn't deployed on mainnet yet)
export const CHAIN_ID = import.meta.env.VITE_CHAIN_ID ? parseInt(import.meta.env.VITE_CHAIN_ID, 10) : 5201420;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.ankr.com/electroneum_testnet/";
export const EXPLORER_BASE_URL = import.meta.env.VITE_EXPLORER_BASE_URL || "https://testnet-blockexplorer.electroneum.com";

// Contract addresses
export const MARKETPLACE_ADDRESS = import.meta.env.VITE_MARKETPLACE_ADDRESS || "0x09194a12fd71eC420449cc6709E3991a5103C69A";
// Block MARKETPLACE_ADDRESS was deployed at — the public RPC rejects eth_getLogs queries with an
// unscoped fromBlock ("Block range is too large"), so log scans (e.g. discovering which domains
// have a subname price set) start here instead of from genesis. Must be updated alongside
// MARKETPLACE_ADDRESS on every redeploy.
export const MARKETPLACE_DEPLOY_BLOCK = import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK, 10)
  : 14667390;
export const REGISTRAR_CONTROLLER_ADDRESS = import.meta.env.VITE_REGISTRAR_CONTROLLER_ADDRESS || "0x5BFb2958062Ac12d2019Ac1E69243DDbafCCc2c5";
export const BASE_REGISTRAR_ADDRESS = import.meta.env.VITE_BASE_REGISTRAR_ADDRESS || "0x7b787b31Ad58D563D7B3938b4bbfAB2c588624C5";
// registerName() always wraps — the raw ERC721 ends up owned by NameWrapper itself, so
// ownership lookups for any registered name must query NameWrapper.ownerOf(node), not
// BaseRegistrar.ownerOf(tokenId) (which just returns NameWrapper's own address post-wrap).
export const NAME_WRAPPER_ADDRESS = import.meta.env.VITE_NAME_WRAPPER_ADDRESS || "0x388f495A886644883F41a5958C11382e7c0D23F5";

// namehash("etn") — Electroneum's ENS fork uses its own TLD, not "eth". Confirmed on-chain:
// ENSRegistry.owner(this node) returns exactly BaseRegistrarImplementation's address.
export const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

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

// Reown
export const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID || "146ee334d324044083b6427d4bbf9202";

// Backend — NFT image generation + R2 upload (see backend/index.js)
export const BACKEND_IMAGE_URL = import.meta.env.VITE_BACKEND_IMAGE_URL || "https://electroneumnameservice.onrender.com";
