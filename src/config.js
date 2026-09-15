// Chain — Electroneum MAINNET (52014). PlanetZephyrosSubdomainNameServiceV3 is now deployed here
// too; testnet (5201420) is reachable via the env var overrides below if needed.
export const CHAIN_ID = import.meta.env.VITE_CHAIN_ID ? parseInt(import.meta.env.VITE_CHAIN_ID, 10) : 52014;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.ankr.com/electroneum";
export const EXPLORER_BASE_URL = import.meta.env.VITE_EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";

// Contract addresses
// Redeployed 2026-09-15 as PlanetZephyrosSubdomainServiceV4 — multi-currency subname pricing
// (ETN + any owner-whitelisted ERC20, address(0) = ETN throughout the ABI), a goldlist for
// activation-fee-exempt domains, and constructor-seeded initial pricing. V3 has no upgrade path
// (plain Ownable, immutable constructor wiring), so this is a new deployment, not the previous
// contract's bytecode changing in place — migrateActivation() lets a domain already activated on
// V3 carry that status over for free, but existing V3 subname prices do NOT carry over
// automatically; each owner needs to re-call setSubnamePricePerYear on V4 themselves.
// V3 (0x392fd031910e5D58650160f41a501ccc29B1eD13, block 15207471) is left live on-chain as
// PlanetZephyrosSubdomainServiceV4's own legacyMarketplace reference, not pointed at by this app
// anymore. Earlier V3/V2 deployments
// (0xd9BC87b41c8011c9CaEeda91167cacfFD91Cd22c block 15204649;
// 0x775c9BF1516811349915fC50E471875252Bb5Ef3 block 15201936;
// 0x1191C7c0558F52a7282C00Bc477aA16187C1fE64 block 15188489) are also left live on-chain.
export const MARKETPLACE_ADDRESS = import.meta.env.VITE_MARKETPLACE_ADDRESS || "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2";
// Block MARKETPLACE_ADDRESS was deployed at — the public RPC rejects eth_getLogs queries with an
// unscoped fromBlock ("Block range is too large"), so log scans (e.g. discovering which domains
// have a subname price set) start here instead of from genesis. Must be updated alongside
// MARKETPLACE_ADDRESS on every redeploy.
export const MARKETPLACE_DEPLOY_BLOCK = import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(import.meta.env.VITE_MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15873016;
// Marketplace contract owner — confirmed live via eth_call to owner() on MARKETPLACE_ADDRESS
// right after the V4 deploy (same address V3 already used, unchanged). Gates the buyBackAndBurn
// button in BurnPoolCard: that function is onlyOwner on-chain, so anyone else's wallet would just
// get a revert. Must be kept in sync if ownership is ever transferred (transferOwnership) or the
// contract is redeployed.
export const MARKETPLACE_OWNER_ADDRESS = "0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099";
// The deprecated V3 marketplace (PlanetZephyrosSubdomainServiceV3) — no longer pointed at for any
// write, but its totalCoreBurned/sellerAmount history is real lifetime activity that shouldn't
// vanish from the site's stats just because V4 is a fresh contract starting its own on-chain
// counters at 0. Lifetime "Total CORE Burned" (useBurnPool.js) reads this contract's
// totalCoreBurned() too and adds it to V4's own, so the figure shown is V3 + V4, not V4-only.
export const LEGACY_MARKETPLACE_ADDRESS = import.meta.env.VITE_LEGACY_MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
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

// The real ENS Registry (confirmed via BaseRegistrar.ens() / NameWrapper.ens() both returning
// this exact address) — source of truth for which resolver is actually assigned to a given node,
// so forward-record reads/writes (setAddr) always target whatever resolver a name is genuinely
// pointed at, not an assumed default. Every wrapped name in this app currently resolves through
// Electroneum's own PublicResolver, 0xDb4A3Abb6703232e20a118a104e7f4EbB3e2738D (not something we
// deploy/control), but reading it dynamically means this keeps working if that ever changes for
// a given name (e.g. via NameWrapper.setResolver).
export const ENS_REGISTRY_ADDRESS =
  import.meta.env.VITE_ENS_REGISTRY_ADDRESS || "0x6F311F2212593165988Dff84977e24C1005dBb85";

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

// Premium Feature #1 — Per-Wallet PnL Statements (see PlanetZephyros repo,
// contracts/premium/PremiumSubscription.sol, and this backend's backend/utils/pnlStatementRouter.js).
// Deployed to MAINNET 2026-08-31: 0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1, block 15621940, tx
// 0x05cbbc0c8eb1aef641695aef5bde132445fe21dd704b911b17ddf169e944b1a3. owner/coreToken/swapRouter
// confirmed correct on-chain post-deploy; operator/splitDestination were INITIALLY wired to an
// unexpected address (not the intended CORE_CLASH_BACKEND_PRIVATE_KEY address) — likely a stale
// Remix workspace copy of the deploy script — caught via a failed executeSplitForPeriod dry run
// ("Not operator" revert) and corrected via setOperator/setSplitDestination before going live; see
// PlanetZephyros's deployPremiumSubscription_mainnet_remix.ts for the deploy script itself. Full
// dry run (100 ETN purchase -> split -> real ETN->CORE swap -> burn) verified working end-to-end
// on mainnet before pnlPricePerPeriod was reset from its 100 ETN test value to its real price.
export const PREMIUM_SUBSCRIPTION_ADDRESS =
  import.meta.env.VITE_PREMIUM_SUBSCRIPTION_ADDRESS || "0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1";

// Same backend as BACKEND_IMAGE_URL above (one backend serves both) — separate constant purely
// for readability at call sites that have nothing to do with NFT images.
export const PNL_BACKEND_URL = import.meta.env.VITE_PNL_BACKEND_URL || BACKEND_IMAGE_URL;

// Public (no-auth) base URL for the R2 bucket NFT images are uploaded to — the bucket's
// "Enable public access" r2.dev subdomain, not the Cloudflare account/dashboard itself. Safe to
// ship in the frontend bundle: it only serves what's already meant to be publicly readable.
// See backend/utils/R2Upload.js (same value, as R2_PUBLIC_URL) and utils/ens.js's
// computeNftImageUrl for how a name's object key is derived.
export const R2_PUBLIC_URL = import.meta.env.VITE_R2_PUBLIC_URL || "https://pub-deada542de8447159d3f31e49afa0b23.r2.dev";

// Every browser-side JSON cache read (dashboard stats, owned names, ETN price, etc.) goes through
// this backend proxy (backend/utils/r2CacheProxyRouter.js) instead of hitting R2_PUBLIC_URL
// directly. Found live: Cloudflare's r2.dev "Public Development URL" doesn't apply the bucket's
// CORS policy at all (documented as dev-only/rate-limited; CORS is only ever mentioned for custom
// domains, which need a paid Cloudflare plan or a DNS migration this project's domain — hosted on
// Vercel — didn't want to do), so a real browser fetch() against it fails even though the object
// itself is perfectly fine (confirmed via curl succeeding for the exact same URL every time). A
// server-to-server fetch (this backend already has to R2 for the *write* side of every cache
// anyway) never involves browser CORS at all, sidestepping the problem entirely. NFT images stay
// a direct R2_PUBLIC_URL read (see utils/ens.js) since an <img src> never needed CORS either way.
export const r2ProxyUrl = (filename) => `${BACKEND_IMAGE_URL}/api/r2/${filename}`;
