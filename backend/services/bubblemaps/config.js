import { ELECTROSWAP_LISTED_TOKENS } from "../../utils/electroSwapTokens.js";

function numberEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const coreToken = ELECTROSWAP_LISTED_TOKENS.find((token) => token.symbol === "CORE");
if (!coreToken) throw new Error("CORE token is missing from the ElectroSwap token configuration");
export const CORE_TOKEN_ADDRESS = coreToken.address.toLowerCase();
// Increment when CORE holder inclusion rules change so the worker rebuilds its cached map.
export const CORE_TEAM_HOLDER_RULES_VERSION = "1";
export const CORE_TEAM_WALLET_ADDRESSES = Object.freeze([
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099",
  "0x2871835ca982f248f61c3a1995931e205c9d5243",
  "0x21e0056663f3f1d237353f0bba7ed5cf62d09637",
  "0x4eb4b9ce208711a0ea1beff57c83bd66bc563378",
]);

export const BUBBLEMAP_CONFIG = Object.freeze({
  holdersTopN: Math.floor(numberEnv("HOLDERS_TOP_N", 250, 1, 250)),
  hubDegree: Math.floor(numberEnv("HUB_DEGREE", 25, 1, 100000)),
  minLinkValueUsd: numberEnv("MIN_LINK_VALUE_USD", 5, 0, 1e9),
  largeEtnUsd: numberEnv("LARGE_ETN_USD", 200, 0, 1e9),
  bundleBlocks: Math.floor(numberEnv("BUNDLE_BLOCKS", 3, 0, 1000)),
  launchWindowHours: numberEnv("LAUNCH_WINDOW_HOURS", 24, 0, 8760),
  minTokenTransferShare: numberEnv("MIN_TOKEN_TRANSFER_SHARE", 0.1, 0, 1),
  clusterThreshold: numberEnv("CLUSTER_THRESHOLD", 0.8, 0, 2),
  maxClusterHolderShare: numberEnv("MAX_CLUSTER_HOLDER_SHARE", 0.2, 0.01, 1),
  holderRefreshMs: numberEnv("HOLDER_REFRESH_HOURS", 6, 0.1, 8760) * 60 * 60 * 1000,
  maxTxPagesPerAddress: Math.floor(numberEnv("MAX_TX_PAGES_PER_ADDRESS", 5, 1, 1000)),
  blockscoutRps: numberEnv("BLOCKSCOUT_RPS", 5, 0.1, 100),
  workerTickMs: numberEnv("BUBBLEMAP_WORKER_TICK_MS", 60_000, 10_000, 86_400_000),
  maxTransferPagesPerTick: Math.floor(numberEnv("BUBBLEMAP_TRANSFER_PAGES_PER_TICK", 8, 1, 100)),
  maxAddressesPerTick: Math.floor(numberEnv("BUBBLEMAP_ADDRESSES_PER_TICK", 10, 1, 1000)),
  maxMapBytes: Math.floor(numberEnv("BUBBLEMAP_MAX_BYTES", 100_000, 10_000, 1_000_000)),
  maxMapEdges: Math.floor(numberEnv("BUBBLEMAP_MAX_EDGES", 300, 10, 5000)),
  edgeWeights: Object.freeze({
    SAME_FUNDER: 1.0,
    BUNDLED_BUY: 0.8,
    TOKEN_TRANSFER: 0.7,
    ETN_TRANSFER_REPEATED: 0.5,
    ETN_TRANSFER_SINGLE: 0.15,
    SHARED_COUNTERPARTY: 0.1,
  }),
});
