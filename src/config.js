// Chain — Electroneum Testnet (PlanetZephyrosNameMarketplace isn't deployed on mainnet yet)
export const CHAIN_ID = import.meta.env.VITE_CHAIN_ID ? parseInt(import.meta.env.VITE_CHAIN_ID, 10) : 5201420;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.ankr.com/electroneum_testnet/";
export const EXPLORER_BASE_URL = import.meta.env.VITE_EXPLORER_BASE_URL || "https://testnet-blockexplorer.electroneum.com";

// Contract addresses
// TODO: MARKETPLACE_ADDRESS is the pre-renewName deployment — update once
// scripts/deployMarketplace_remix.ts has been re-run after adding renewName()/quoteRenewal().
export const MARKETPLACE_ADDRESS = import.meta.env.VITE_MARKETPLACE_ADDRESS || "0xFE8a448D84272Cb363F85B9B9E404Bde92350840";
export const REGISTRAR_CONTROLLER_ADDRESS = import.meta.env.VITE_REGISTRAR_CONTROLLER_ADDRESS || "0x5BFb2958062Ac12d2019Ac1E69243DDbafCCc2c5";
export const BASE_REGISTRAR_ADDRESS = import.meta.env.VITE_BASE_REGISTRAR_ADDRESS || "0x7b787b31Ad58D563D7B3938b4bbfAB2c588624C5";

// namehash("etn") — Electroneum's ENS fork uses its own TLD, not "eth". Confirmed on-chain:
// ENSRegistry.owner(this node) returns exactly BaseRegistrarImplementation's address.
export const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

// Default registration/renewal duration — 1 year flat, no duration picker in V1.
export const DEFAULT_DURATION_SECONDS = 365 * 24 * 60 * 60;

// Reown
export const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID || "146ee334d324044083b6427d4bbf9202";

// Backend
export const BACKEND_IMAGE_URL = import.meta.env.VITE_BACKEND_IMAGE_URL || "https://your-render-service.onrender.com";
