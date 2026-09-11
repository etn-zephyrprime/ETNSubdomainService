// backend/services/pnlIngestion.js
//
// Per-wallet transfer/trade history ingestion — triggered fresh at statement *request* time, not
// a standing background cron (per the build brief: a wallet's history isn't kept continuously
// current for every tracked wallet regardless of whether a statement was ever requested). On a
// wallet's first-ever request, ingests full history back to its first transaction; subsequent
// requests backfill/confirm anything missed since the last one rather than trusting a
// continuously-running job kept it current (there isn't one).
//
// Scans three Blockscout v2 endpoints per wallet, each with the same keyset-pagination + retry
// shape already proven in dailyBlockStatsCache.js/validatorRewardsCache.js:
//   - /addresses/{address}/transactions        — gas paid by the wallet's own txs, top-level ETN
//   - /addresses/{address}/token-transfers     — ERC20 in/out
//   - /addresses/{address}/internal-transactions — ETN moved by contract calls (e.g. swap
//     proceeds) — invisible to both the plain transaction list and eth_getLogs
//
// SWAP DETECTION — flagged for empirical verification during testnet testing (not yet confirmed
// against a real ElectroSwap trade from an arbitrary wallet, only against the CORE/WETN pool
// specifically in coreClashSwapWatcher.js): a transaction is treated as a swap when it decoded a
// `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out,
// uint256 amount1Out, address indexed to)` log for the tracked wallet (as `sender` or `to`) on any
// address that also appears as the `token`/pool side of one of that same tx's token-transfers.
// Getting this wrong just means an occasional swap shows up as two separate transfers instead of
// one decomposed disposal+acquisition — degrades gracefully, doesn't corrupt totals — but should
// be spot-checked against real trade history before this goes live.
import { ethers } from "ethers";
import { getIngestionState, upsertIngestionState } from "../db/walletIngestionState.js";
import { insertTransfers, getUnpricedTransfers, setTransferPrice } from "../db/ingestedTransfers.js";
import { insertSwapTrades, getSwapTradesWithUnpricedLegs, setSwapLegPrices } from "../db/swapTrades.js";
import { listCexAddresses } from "../db/cexAddresses.js";
import { insertDefiActivity } from "../db/defiActivity.js";
import { getHistoricalPriceUsd, getCachedHistoricalPriceUsd } from "./pnlPricing.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { createPrimaryNameResolver } from "../utils/primaryNameResolver.js";

const BLOCKSCOUT_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
export const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
// Blockscout's legacy Etherscan-compatible API — the v2 REST API above has no block-by-timestamp
// equivalent. Used only by getBlockByTimestamp below.
const BLOCKSCOUT_LEGACY_API_BASE = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api`;
// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS / coreClashConfig.js's own copy — used
// only by resolveEnsDisplayName below.
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";
const MAX_RETRIES = 3;
const PAGE_DELAY_MS = process.env.PNL_INGESTION_PAGE_DELAY_MS ? parseInt(process.env.PNL_INGESTION_PAGE_DELAY_MS, 10) : 150;
// Node's built-in fetch has no default request timeout — confirmed live this let a single statement
// generation hang indefinitely with no error, no crash, and near-zero CPU/memory the whole time
// (a stalled/silently-dropped connection to Blockscout just never resolves await fetch(), and
// nothing here was ever going to time it out). Every fetch() in this file passes this as its
// signal now. 20s is generous for a small JSON response from any of these APIs under normal
// conditions; a real hang is caught well before a customer notices something's "just slow."
const FETCH_TIMEOUT_MS = process.env.PNL_FETCH_TIMEOUT_MS ? parseInt(process.env.PNL_FETCH_TIMEOUT_MS, 10) : 20000;

// Render log visibility into a run that can take many minutes — per the user's own words, "I am
// blind to know what is going on" while a statement generates. Throttled to at most once every
// PROGRESS_LOG_INTERVAL_MS per walk/scan so a page-heavy wallet doesn't flood the log stream.
const PROGRESS_LOG_INTERVAL_MS = process.env.PNL_PROGRESS_LOG_INTERVAL_MS
  ? parseInt(process.env.PNL_PROGRESS_LOG_INTERVAL_MS, 10)
  : 15000;

const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);

// V2 add/remove-liquidity — ElectroSwap's V2 pairs are unmodified standard UniswapV2Pair contracts
// (confirmed live against a real deployed pair's verified/bytecode-matched ABI on Blockscout, not
// assumed): Mint(sender, amount0, amount1) on add, Burn(sender, amount0, amount1, to) on remove.
// The pair contract IS the LP token itself (its own Transfer/Approval/balanceOf) — see
// detectAndRecordLiquidityEvent's own comment for how that's used to find the wallet's own legs
// without needing to know token0/token1 ordering or make any extra on-chain calls.
const LP_IFACE = new ethers.Interface([
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);
const MINT_TOPIC = LP_IFACE.getEvent("Mint").topicHash;
const BURN_TOPIC = LP_IFACE.getEvent("Burn").topicHash;

// V3 concentrated-liquidity positions — ElectroSwap's real, verified NonfungiblePositionManager
// (confirmed live on Blockscout: genuinely verified, not a proxy, named "NonfungiblePositionManager",
// standard Uniswap V3 design) and its factory (confirmed via the position manager's own verified
// constructor args). A V3 position is an ERC-721 (tokenId), not a fungible pair-contract token like
// V2's LP — IncreaseLiquidity/DecreaseLiquidity/Collect carry no wallet address in their own topics
// (only tokenId, indexed), so unlike the farm/staking scan these can't be found by a wallet-pinned
// topic scanned chain-wide; detected per-tx instead, same approach as V2 LP detection above.
//
// Confirmed live from the position manager's own verified Solidity source (not assumed):
//  - mint() calls the same internal addLiquidity() as increaseLiquidity() and both end by emitting
//    the identical IncreaseLiquidity(tokenId, liquidity, amount0, amount1) — this app doesn't need
//    to tell a brand-new position apart from a top-up of an existing one; either way the effect on
//    the position's own lot bucket (see POSITION_MANAGER_ADDRESS below) is the same: dispose the
//    underlying token0/token1 actually pulled from the wallet, acquire that much more `liquidity`.
//  - decreaseLiquidity() does NOT move any tokens — it only credits position.tokensOwed0/1
//    internally (`position.tokensOwed0 += ...`, confirmed in the verified source). Its own
//    amount0/amount1 event args are the real underlying value released by the burn, computed from
//    the pool's own accounting — reliable, just not yet actually sitting in the wallet.
//  - collect() is the only step that actually moves tokens, and sends them POOL -> recipient
//    directly (`pool.collect(recipient, ...)`), never routed through the position manager itself.
//    Its own Collect(tokenId, recipient, amount0, amount1) amount COMBINES whatever a prior
//    decreaseLiquidity() released (if not yet collected) with genuinely-accrued LP fee income — the
//    two are indistinguishable from Collect's own event data alone.
//
// Given that: DecreaseLiquidity is recorded as ONLY a position-lot disposal (liquidity out, proceeds
// = the real FMV of amount0/amount1 at decrease time) — no underlying-token acquisition is recorded
// yet, since the tokens genuinely aren't in the wallet until a later collect() actually sends them.
// Collect is where underlying-token acquisition is recorded, split (via same-tx correlation, the
// bundled "remove liquidity" pattern essentially every V3 router/frontend multicalls together): the
// portion matching a same-tx DecreaseLiquidity for the same tokenId is priced at THAT decrease's own
// per-unit value (a value-neutral position-asset -> underlying-token conversion, not a fresh gain/
// loss purely from the decrease-vs-collect timing gap); anything beyond that is zero-cost-basis fee
// income, same convention already established for farm/staking reward claims elsewhere in this file.
// A standalone collect() with no same-tx decrease (a routine "just claim my fees" call) is fee
// income in full. KNOWN LIMITATION, documented rather than silently guessed around: a decrease and
// its collect done in two SEPARATE transactions (uncommon — routers multicall these together) won't
// be correlated, so that collect's principal portion gets misclassified as fee income instead of a
// value-neutral conversion — degrades gracefully (still records real data, doesn't corrupt the
// disposal side or double-count) rather than silently dropping or fabricating anything.
//
// The position itself is tracked as a fungible per-tokenId lot bucket keyed
// `${POSITION_MANAGER_ADDRESS}:${tokenId}` (same composite-key shape as this app's NFT PnL
// tracking, but assetType "erc20" here so it flows through the plain transferToEvent disposal/
// acquisition path like V2's LP token above, not the NFT same-tx-payment machinery, which assumes a
// different shape). Its "quantity" is LIQUIDITY units (the position's own internal accounting unit,
// used as-is — not token-decimals-scaled), not "1 NFT": a partial decrease disposes only part of the
// lot, which plain FIFO quantity math already handles correctly with zero fifoLotEngine.js changes,
// same as any other fungible asset. Like V2's LP token, this has no market price feed of its own —
// cost basis/proceeds are always computed directly from the real underlying legs, omitted (null)
// rather than fabricated when a leg is unpriced. OUT OF SCOPE for now (not yet handled, same "note
// what's deferred" discipline as the brief's own IL/APY deferral): selling/transferring an entire
// position NFT itself on a marketplace rather than through the position manager's own functions.
// Exported so callers that need to tell a V3 position's composite key apart from a real NFT's
// (same "address:tokenId" shape, see pnlEventBuilder.js's groupNftHoldingsByCollection) — or that
// need the address itself for a live position lookup, see lpPositionValuation.js — don't have to
// duplicate this address.
export const POSITION_MANAGER_ADDRESS = "0x3a7f64c57433555b23dac4409a0ac7e84275398d";
const V3_FACTORY_ADDRESS = "0xbf6bcbe2be545135391777f3b4698be92e2eb8ca";
const V3_IFACE = new ethers.Interface([
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
]);
const V3_INCREASE_TOPIC = V3_IFACE.getEvent("IncreaseLiquidity").topicHash;
const V3_DECREASE_TOPIC = V3_IFACE.getEvent("DecreaseLiquidity").topicHash;
const V3_COLLECT_TOPIC = V3_IFACE.getEvent("Collect").topicHash;
const V3_POSITIONS_VIEW_IFACE = new ethers.Interface([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const V3_FACTORY_VIEW_IFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const ERC20_DECIMALS_VIEW_IFACE = new ethers.Interface(["function decimals() view returns (uint8)"]);

// token0/token1/fee never change post-mint for a given tokenId — cached indefinitely, same
// reasoning as tokenMetadataCache below.
const v3PositionTokensCache = new Map(); // tokenId (string) -> { token0, token1, fee } | null
async function getV3PositionTokens(tokenId) {
  const key = String(tokenId);
  if (v3PositionTokensCache.has(key)) return v3PositionTokensCache.get(key);
  let result = null;
  try {
    const contract = new ethers.Contract(POSITION_MANAGER_ADDRESS, V3_POSITIONS_VIEW_IFACE, createRpcProvider());
    const pos = await contract.positions(tokenId);
    result = { token0: String(pos.token0).toLowerCase(), token1: String(pos.token1).toLowerCase(), fee: Number(pos.fee) };
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not read positions(${tokenId}) on the V3 position manager:`, err.message);
  }
  v3PositionTokensCache.set(key, result);
  return result;
}

// A given (token0, token1, fee) triple's pool address never changes — cached indefinitely.
const v3PoolAddressCache = new Map(); // "token0:token1:fee" -> address (lowercase) | null
async function getV3PoolAddress(token0, token1, fee) {
  const key = `${token0}:${token1}:${fee}`;
  if (v3PoolAddressCache.has(key)) return v3PoolAddressCache.get(key);
  let result = null;
  try {
    const contract = new ethers.Contract(V3_FACTORY_ADDRESS, V3_FACTORY_VIEW_IFACE, createRpcProvider());
    const pool = await contract.getPool(token0, token1, fee);
    if (pool && pool !== ethers.ZeroAddress) result = String(pool).toLowerCase();
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not resolve the V3 pool address for ${key}:`, err.message);
  }
  v3PoolAddressCache.set(key, result);
  return result;
}

// A token's decimals() never changes post-deploy — cached indefinitely. Separate from
// tokenMetadataCache below (that one's a Blockscout REST call for name/symbol; this is a live RPC
// read for decimals specifically, needed here because DecreaseLiquidity/Collect amounts have no
// corresponding Blockscout token-transfer entry to read `.token.decimals` off of the way every
// other pricing path in this file does — decreaseLiquidity() moves no tokens at all, and this app
// deliberately doesn't rely on Collect's real transfer log for its amounts either, see this
// function's own doc comment above on why).
const tokenDecimalsCache = new Map(); // address (lowercase) -> number
async function getTokenDecimalsCached(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenDecimalsCache.has(key)) return tokenDecimalsCache.get(key);
  let result = 18;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_DECIMALS_VIEW_IFACE, createRpcProvider());
    result = Number(await contract.decimals());
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not read decimals() for ${tokenAddress}, assuming 18:`, err.message);
  }
  tokenDecimalsCache.set(key, result);
  return result;
}

function v3PositionAssetKey(tokenIdStr) {
  return `${POSITION_MANAGER_ADDRESS}:${tokenIdStr}`;
}

// DeFi (yield farm / staking) activity — detected by EVENT TOPIC across the whole chain, not a
// hardcoded contract address list. Confirmed live: the "YieldFarm" LP-farm template and the
// "CoreAscension"-style staking template are each reused verbatim across multiple deployed
// instances (3 separate YieldFarm contracts, 2 separate staking contracts, byte-for-byte identical
// event signatures) — so scanning by these fixed topic hashes picks up any *future* instance of
// either template automatically, with zero code change or address list to maintain. See
// pnlStatementGenerator.js's buildDefiFarmEvents for how token identity gets resolved (live
// contract reads on whichever address actually emitted the event, cached — never hardcoded here
// either).
const DEFI_IFACE = new ethers.Interface([
  "event FarmDeposit(uint256 indexed farmId, address indexed farmer, uint256 amount0Added, uint256 amount1Added, uint256 liquidityAdded)",
  // Emitted instead of FarmDeposit when a farmer adds to an ALREADY-open position rather than
  // opening a new one (confirmed live against the deployed YieldFarm ABI — same amount0Added/
  // amount1Added/liquidityAdded shape, plus adjustedStartingBlock which this app doesn't need).
  // Missing this meant any wallet whose first-ever farm interaction was a deposit but later
  // top-ups went through this event instead had those top-ups silently absent from both the PnL
  // ledger and the live position-value lookup below — confirmed live on a real wallet.
  "event FarmIncrease(uint256 indexed farmId, address indexed farmer, uint256 amount0Added, uint256 amount1Added, uint256 liquidityAdded, uint256 adjustedStartingBlock)",
  "event FarmWithdrawl(uint256 indexed farmId, address indexed farmer, uint256 amount0Withdrawn, uint256 amount1Withdrawn, uint256 amountRewards, uint256 fees0Collected, uint256 fees1Collected, uint256 thirdPartyRewardsCollected)",
  "event CoreStaked(address indexed user, uint256 amount)",
  "event CoreWithdrawn(address indexed user, uint256 requestedAmount, uint256 returnedAmount, uint256 penaltyToPool, uint256 penaltyBurned)",
  "event RewardPaid(address indexed user, uint256 paidAmount, uint256 slashedAmount)",
]);
const FARM_DEPOSIT_TOPIC = DEFI_IFACE.getEvent("FarmDeposit").topicHash;
const FARM_INCREASE_TOPIC = DEFI_IFACE.getEvent("FarmIncrease").topicHash;
const FARM_WITHDRAW_TOPIC = DEFI_IFACE.getEvent("FarmWithdrawl").topicHash;
const CORE_STAKED_TOPIC = DEFI_IFACE.getEvent("CoreStaked").topicHash;
const CORE_WITHDRAWN_TOPIC = DEFI_IFACE.getEvent("CoreWithdrawn").topicHash;
const REWARD_PAID_TOPIC = DEFI_IFACE.getEvent("RewardPaid").topicHash;
// BOLT's real token contract — confirmed live from the YieldFarm contract's own verified
// constructor args on Blockscout (_boltToken), not assumed. A farmer can optionally deposit BOLT
// alongside their LP deposit (YieldFarm.sol's `deposit(farmId, amount0, amount1, amountBolt)`) for
// a rewards multiplier, and gets it back via a plain ERC20 transfer() when they later withdraw
// their entire position — but the AMOUNT never appears in the FarmDeposit/FarmIncrease/
// FarmWithdrawl event args themselves (confirmed against the real event ABI), only as a same-tx
// standard Transfer log. See enrichFarmRowsWithBolt below for how that gets correlated in.
const BOLT_TOKEN_ADDRESS = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";
const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC20_TRANSFER_IFACE = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
// farmer is FarmDeposit/FarmWithdrawl's SECOND indexed param (topics[2]) — farmId is the first.
const FARM_EVENT_WALLET_TOPIC_INDEX = 2;
// user is CoreStaked/CoreWithdrawn/RewardPaid's ONLY indexed param besides the signature itself
// (topics[1]).
const STAKING_EVENT_WALLET_TOPIC_INDEX = 1;
// Confirmed live (direct RPC probes, not a guess) that this scan's two endpoints have wildly
// different real limits for an eth_getLogs call with NO address filter (matching by topic alone
// across the whole chain — inherently more expensive for an RPC backend to serve than the
// address-scoped calls every other getLogs scan in this codebase uses, which is why
// coreClashBurnWatcher.js's 500-block MAX_BLOCK_RANGE doesn't apply here): the primary (Ankr)
// rejects a filterless request anywhere above ~1000-2000 blocks with "Block range is too large",
// while the secondary (Electroneum's own public node) served a 100,000-block filterless request
// with zero issue. A wallet's first-ever DeFi scan covers the chain's ENTIRE history (see
// ingestDefiActivity's stopAtDefiBlock handling) — at a 500-block window that's tens of thousands
// of sequential round-trips per topic and took long enough in practice to be impractical. 20000
// keeps real margin below the proven-safe 100000 while cutting chunk count by ~40x; queryDefiLogsChunked's
// shrink-and-retry still exists as the safety net for whichever specific window a request lands on.
const DEFI_LOG_CHUNK_SIZE = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves the block number closest to `timestamp` via Blockscout's legacy Etherscan-compatible
 * API (module=block&action=getblocknobytime) — informational only, for showing a human-checkable
 * block range on a generated statement (see pnlStatementGenerator.js). Never used for the actual
 * period slicing, which stays timestamp-based (see that file's header comment on why: ingestion
 * pages through Blockscout's v2 endpoints by keyset cursor, not block range). `closest` is
 * Blockscout's own param — "before" or "after". */
export async function getBlockByTimestamp(timestamp, closest = "before") {
  const unixSeconds = Math.floor(timestamp.getTime() / 1000);
  const url = `${BLOCKSCOUT_LEGACY_API_BASE}?module=block&action=getblocknobytime&timestamp=${unixSeconds}&closest=${closest}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} resolving block by timestamp`);
  const json = await res.json();
  if (json.status !== "1" || !json.result?.blockNumber) {
    throw new Error(`Unexpected response resolving block by timestamp: ${JSON.stringify(json)}`);
  }
  return Number(json.result.blockNumber);
}

// Token name/symbol never changes post-deploy in any way this app cares about — no TTL needed,
// unlike the price caches elsewhere in this feature.
const tokenMetadataCache = new Map(); // address (lowercase) -> { name, symbol } | null

/** Resolves a token's name/symbol via Blockscout, cached indefinitely per address. Returns null
 * (not a throw) on any failure — callers treat missing metadata as "show the raw address instead",
 * never as a reason to fail statement generation. */
export async function getTokenMetadata(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenMetadataCache.has(key)) return tokenMetadataCache.get(key);

  let result = null;
  try {
    const res = await fetch(`${BLOCKSCOUT_API_BASE}/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.name || json.symbol) result = { name: json.name || null, symbol: json.symbol || null };
  } catch (err) {
    console.warn(`⚠️  Could not fetch token metadata for ${tokenAddress}:`, err.message);
  }
  tokenMetadataCache.set(key, result);
  return result;
}

// Reuses the exact same ReverseRegistrar+resolver chain the Core Clash Telegram bots already use
// (see primaryNameResolver.js's own header comment on why this is centralized rather than
// reimplemented per call site) — one shared resolver instance/provider for the life of the
// process, not per-call.
let cachedEnsResolver = null;
function getEnsResolver() {
  if (!cachedEnsResolver) {
    const provider = createRpcProvider();
    cachedEnsResolver = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);
  }
  return cachedEnsResolver;
}

/** Resolves `address`'s primary ENS name, or null if it doesn't have one / resolution fails —
 * callers show the raw address either way (see formatAssetLabel-style callers in
 * pnlStatementGenerator.js), this only ever adds a friendlier name alongside it, never replaces
 * the address as the source of truth. */
export async function resolveEnsDisplayName(address) {
  try {
    const resolveDisplayName = getEnsResolver();
    const result = await resolveDisplayName(address);
    // primaryNameResolver's own contract falls back to a shortened address string (e.g.
    // "0x1234...abcd") when there's no primary name set — that's not a real ENS name, so callers
    // here want null instead of that shortened-address fallback (this file already has the full
    // address on hand and formats it consistently itself).
    return result && result.startsWith("0x") ? null : result;
  } catch (err) {
    console.warn(`⚠️  Could not resolve ENS name for ${address}:`, err.message);
    return null;
  }
}

async function fetchPage(path, cursorParams, attempt = 0) {
  const url = new URL(`${BLOCKSCOUT_API_BASE}${path}`);
  if (cursorParams) {
    for (const [key, value] of Object.entries(cursorParams)) url.searchParams.set(key, value);
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } catch (err) {
    // A timeout throws the same as any other network failure here, so it falls through to the
    // existing retry path below rather than needing special-case handling.
    if (attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchPage(path, cursorParams, attempt + 1);
    }
    throw err;
  }
}

/** Walks every page of a Blockscout address-scoped endpoint, calling `onPage(items)` for each,
 * until next_page_params is exhausted or an item's block is at/below `stopAtBlock` (exclusive —
 * used for incremental catch-up, where we only want blocks newer than the last ingested one;
 * pass null to walk the endpoint's entire available history, used for cold start).
 *
 * `label`, if given, turns on throttled progress logging (see PROGRESS_LOG_INTERVAL_MS) — each
 * line shows how far BACK into the wallet's history this walk has reached (pages come newest-first,
 * confirmed live, so the LAST item on a page is always the furthest-back one seen so far) plus an
 * approximate % of the SCANNED BLOCK RANGE (latest chain block down to stopAtBlock, or down to
 * block 0 for a cold start) — not the wallet's own true history span, which isn't knowable up front
 * without an extra lookup, but a real, monotonically-increasing number regardless. Fetching
 * latestBlockAtStart is itself wrapped in try/catch — this is purely informational and must never
 * fail or slow down the actual walk. */
async function walkAllPages(path, stopAtBlock, onPage, label) {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let latestBlockAtStart = null;
  if (label) {
    try {
      latestBlockAtStart = await createRpcProvider().getBlockNumber();
    } catch {
      // Progress logging is informational only — an RPC hiccup here just means no % this run.
    }
  }

  let cursor;
  let itemCount = 0;
  for (;;) {
    const page = await fetchPage(path, cursor);
    const items = page.items || [];
    if (items.length === 0) break;

    const relevant = stopAtBlock != null ? items.filter((it) => Number(it.block_number) > stopAtBlock) : items;
    if (relevant.length > 0) await onPage(relevant);
    itemCount += relevant.length;

    if (label && relevant.length > 0) {
      const now = Date.now();
      if (now - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastLoggedAt = now;
        const oldest = relevant[relevant.length - 1];
        const oldestBlock = Number(oldest.block_number);
        const oldestDate = oldest.timestamp ? new Date(oldest.timestamp).toISOString().slice(0, 10) : "unknown date";
        const elapsedSec = Math.round((now - startedAt) / 1000);
        let pctText = "";
        if (latestBlockAtStart != null) {
          const totalSpan = latestBlockAtStart - (stopAtBlock ?? 0);
          if (totalSpan > 0) {
            const pct = Math.min(100, Math.max(0, Math.round(((latestBlockAtStart - oldestBlock) / totalSpan) * 100)));
            pctText = `, ~${pct}% of scanned block range`;
          }
        }
        console.log(`📊 [${label}] reached ${oldestDate} (block ${oldestBlock}) — ${itemCount} item(s) so far, ${elapsedSec}s elapsed${pctText}`);
      }
    }

    if (relevant.length < items.length || !page.next_page_params) break; // rest of this page (and everything after) is already-ingested territory
    cursor = page.next_page_params;
    await sleep(PAGE_DELAY_MS);
  }
}

function weiToDecimal(wei, decimals = 18) {
  return Number(ethers.formatUnits(wei, decimals));
}

// `priorityAssets` (a Set of lowercased token addresses, or null/undefined meaning "price
// everything fully" — the ORIGINAL, unscoped behavior) lets a caller defer the expensive part of
// pricing a NEW-to-this-app token (ensureBackfilled's full GeckoTerminal OHLCV crawl, up to 20
// rate-limited pages) for any asset it doesn't care about right now, while still getting a price
// for free if that asset happens to already be cached from some OTHER wallet's activity. Native
// ETN is NEVER deferred regardless of priorityAssets — gas fees always need pricing, and ETN is
// essentially always already cached anyway (every wallet touches it).
//
// This is what backs the Core tier "ongoing dashboard PnL" cold-start speedup (see
// pnlSnapshotService.js's own header comment): a member selects which tokens they want prioritized,
// ingestion prices JUST those (plus ETN) in full, and everything else gets recorded with a null
// price for now — backfillDeferredPrices below re-prices those specific rows afterward, in the
// background, without re-walking Blockscout at all. generateStatement (pnlStatementGenerator.js)
// NEVER passes priorityAssets — a Statement always gets full, complete pricing, no deferral, by
// construction (it doesn't have this parameter threaded into its own ingestWalletHistory call).
async function priceOrNull(asset, timestamp, priorityAssets) {
  const isNative = asset === "NATIVE";
  if (priorityAssets && !isNative && !priorityAssets.has(asset.toLowerCase())) {
    return getCachedHistoricalPriceUsd(asset, timestamp); // never throws, already cache-only
  }
  try {
    return await getHistoricalPriceUsd(asset, timestamp);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not price ${asset} @ ${timestamp.toISOString()}:`, err.message);
    return null;
  }
}

/** Detects whether a single /transactions item `tx` is an ElectroSwap trade — same heuristic as
 * before (see this file's header comment): fetch the tx's logs, look for a Swap topic naming the
 * tracked wallet as sender/to, then match the sold/bought legs against its own token_transfers.
 * Only ever called for contract-interaction txs that already have token transfers attached
 * (checked by the caller), so this is never wasted on a plain ETN send. On a match, records the
 * trade into `swapRows` and the tx hash into `swapTxHashes`, and returns true so the caller skips
 * emitting this tx's native/token legs as plain transfers instead. */
async function detectAndRecordSwap(trackedWallet, walletLc, tx, tokenTransfers, swapTxHashes, swapRows, priorityAssets) {
  let logsPage;
  try {
    logsPage = await fetchPage(`/transactions/${tx.hash}/logs`, null);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not fetch logs for tx ${tx.hash}, skipping swap detection for it:`, err.message);
    return false;
  }

  const swapLog = (logsPage.items || []).find((l) => (l.topics || [])[0] === SWAP_TOPIC);
  if (!swapLog) return false;

  let parsed;
  try {
    // Blockscout pads `topics` to a fixed length with trailing nulls for unused slots (confirmed
    // live) — ethers' parseLog expects exactly as many topics as the event actually uses (1
    // signature + N indexed params), not a padded array.
    const realTopics = (swapLog.topics || []).filter((t) => t != null);
    parsed = SWAP_IFACE.parseLog({ topics: realTopics, data: swapLog.data });
  } catch {
    return false;
  }

  const sender = String(parsed.args.sender).toLowerCase();
  const to = String(parsed.args.to).toLowerCase();
  if (sender !== walletLc && to !== walletLc) return false; // this Swap log isn't this wallet's trade

  // Determine which leg the wallet actually sold/bought via the tx's own decoded token transfers —
  // restricted to transfers directly between the wallet and THIS pool (swapLog.address), not just
  // "any transfer from/to the wallet anywhere in the tx". Confirmed live this distinction matters:
  // a tx can contain unrelated later transfers (e.g. a buyBackAndBurn's burn-to-zero-address leg)
  // that would otherwise be misattributed as a swap leg if matched by wallet address alone. A pure
  // ETN<->token swap has only one pool<->wallet token-transfer leg; the other leg is the tx's own
  // native value (handled by the caller's plain-native-transfer logic being skipped for this tx
  // hash, since this function returning true means it's a swap leg instead).
  const poolLc = String(swapLog.address?.hash || swapLog.address).toLowerCase();
  const sold = tokenTransfers.find(
    (t) => String(t.from?.hash).toLowerCase() === walletLc && String(t.to?.hash).toLowerCase() === poolLc
  );
  const bought = tokenTransfers.find(
    (t) => String(t.to?.hash).toLowerCase() === walletLc && String(t.from?.hash).toLowerCase() === poolLc
  );
  if (!sold && !bought) return false; // couldn't identify either leg — don't fabricate a trade

  const timestamp = new Date(tx.timestamp);
  const nativeValue = BigInt(tx.value || "0");

  const soldAddress = sold ? sold.token.address : "NATIVE";
  const soldAmount = sold ? weiToDecimal(BigInt(sold.total.value), Number(sold.token.decimals)) : weiToDecimal(nativeValue);
  const boughtAddress = bought ? bought.token.address : "NATIVE";
  const boughtAmount = bought ? weiToDecimal(BigInt(bought.total.value), Number(bought.token.decimals)) : weiToDecimal(nativeValue);

  const [priceSold, priceBought] = await Promise.all([
    priceOrNull(soldAddress, timestamp, priorityAssets),
    priceOrNull(boughtAddress, timestamp, priorityAssets),
  ]);

  swapTxHashes.add(tx.hash.toLowerCase());
  swapRows.push({
    trackedWallet,
    txHash: tx.hash,
    logIndex: Number(swapLog.index ?? 0),
    poolAddress: swapLog.address?.hash || swapLog.address, // Blockscout returns an address object ({hash, ...}), not a bare string
    tokenSoldAddress: soldAddress,
    amountSold: soldAmount,
    tokenBoughtAddress: boughtAddress,
    amountBought: boughtAmount,
    priceUsdSoldLeg: priceSold,
    priceUsdBoughtLeg: priceBought,
    blockNumber: Number(tx.block_number),
    timestamp,
  });
  return true;
}

/** Detects whether `tx` is a V2 add/remove-liquidity call — same per-tx log-fetch approach as
 * detectAndRecordSwap (only called when that already ruled the tx out as a swap; a real add/
 * remove-liquidity tx never also has a Swap log). See LP_IFACE's own comment for why the pair
 * contract itself IS the LP token: its own Transfer leg to/from the wallet — minted from the zero
 * address on add, sent to the pool then burned to the zero address on remove — is the wallet's own
 * LP-token leg; every OTHER token transfer between the wallet and that same pool address in the
 * same tx is one of the two underlying legs (token0/token1, in whatever order Blockscout lists
 * them — this never needs to know which is which). Reads amounts straight from tokenTransfers, not
 * the Mint/Burn event's own data — the event is only used as a confirming signal that this really
 * is an add/remove-liquidity tx, not a coincidental double-transfer-to-a-contract pattern.
 *
 * The LP token has no market price feed of its own (nothing prices an ElectroSwap pair token
 * directly) — its cost basis (add) / proceeds (remove) is the combined FMV of what was actually
 * given up / received back, computed here directly from the underlying legs' own real prices,
 * never looked up via priceOrNull for the LP token address itself (which would just return null
 * and silently zero the cost basis through transferToEvent's own `?? 0` fallback). Omitted (null),
 * not fabricated, if either underlying leg's own price is unknown — same "omit rather than fake"
 * convention as everywhere else in this app's pricing code.
 *
 * On a match, pushes 3 synthetic transfer rows straight into `rows` (2 underlying legs + 1 LP
 * leg — reusing the exact ingested_transfers shape, so pnlEventBuilder.js's existing
 * transferToEvent needs no changes at all for this to flow through FIFO correctly as a genuine
 * disposal+acquisition) and records the tx hash into `liquidityTxHashes` so the caller's own
 * plain-transfer skip (and ingestWalletHistory's excludeTxHashes) never also emit these same
 * amounts as ordinary transfers. Returns true so the caller skips its own plain-transfer emission
 * for this tx, same contract as detectAndRecordSwap. */
async function detectAndRecordLiquidityEvent(trackedWallet, walletLc, tx, tokenTransfers, liquidityTxHashes, rows, priorityAssets) {
  let logsPage;
  try {
    logsPage = await fetchPage(`/transactions/${tx.hash}/logs`, null);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not fetch logs for tx ${tx.hash}, skipping liquidity-event detection for it:`, err.message);
    return false;
  }

  const mintLog = (logsPage.items || []).find((l) => (l.topics || [])[0] === MINT_TOPIC);
  const burnLog = !mintLog && (logsPage.items || []).find((l) => (l.topics || [])[0] === BURN_TOPIC);
  const eventLog = mintLog || burnLog;
  if (!eventLog) return false;
  const isMint = Boolean(mintLog);

  const poolLc = String(eventLog.address?.hash || eventLog.address).toLowerCase();
  const lpLeg = tokenTransfers.find((t) => {
    const tokenLc = String(t.token?.address).toLowerCase();
    if (tokenLc !== poolLc) return false;
    const fromLc = String(t.from?.hash).toLowerCase();
    const toLc = String(t.to?.hash).toLowerCase();
    return fromLc === walletLc || toLc === walletLc;
  });
  const underlyingLegs = tokenTransfers.filter((t) => {
    const tokenLc = String(t.token?.address).toLowerCase();
    if (tokenLc === poolLc) return false;
    const fromLc = String(t.from?.hash).toLowerCase();
    const toLc = String(t.to?.hash).toLowerCase();
    return (fromLc === walletLc && toLc === poolLc) || (fromLc === poolLc && toLc === walletLc);
  });
  // Requires BOTH underlying legs to be directly identifiable as wallet<->pool token transfers,
  // not just "at least one" — a router-mediated add/remove using native ETN (auto-wrapped to WETN
  // by the router, then transferred router->pool rather than wallet->pool — same "one side isn't a
  // direct wallet<->pool token transfer" shape detectAndRecordSwap's own native-ETN fallback
  // handles for swaps) would otherwise silently decompose with only ONE underlying leg accounted
  // for, understating the LP token's true combined cost basis. Rather than guess at that shape
  // without a real confirmed transaction to verify it against, this simply declines to decompose an
  // ambiguous case at all — it falls through to the existing plain-transfer handling instead, which
  // isn't perfect either (an undecomposed LP-token receipt gets no cost basis, since nothing prices
  // it) but is no WORSE than this app's behavior before this function existed, for exactly the case
  // this function can't yet confidently handle.
  if (!lpLeg || underlyingLegs.length !== 2) return false;

  const timestamp = new Date(tx.timestamp);
  const lpQuantity = weiToDecimal(BigInt(lpLeg.total.value), Number(lpLeg.token.decimals));
  if (lpQuantity <= 0) return false;

  let underlyingUsdTotal = 0;
  let anyUnpriced = false;
  const underlyingRows = [];
  for (const leg of underlyingLegs) {
    const legAddress = leg.token.address;
    const legAmount = weiToDecimal(BigInt(leg.total.value), Number(leg.token.decimals));
    const priceUsd = await priceOrNull(legAddress, timestamp, priorityAssets);
    const usdValue = priceUsd != null ? legAmount * priceUsd : null;
    if (usdValue == null) anyUnpriced = true;
    else underlyingUsdTotal += usdValue;
    underlyingRows.push({
      trackedWallet,
      txHash: tx.hash,
      logIndex: -(2000 + Number(leg.log_index || 0)), // distinct range from every other sentinel used elsewhere in this file
      direction: isMint ? "out" : "in",
      counterpartyAddress: poolLc,
      isSelfTransfer: false,
      isCex: false,
      assetType: "erc20",
      tokenAddress: legAddress,
      tokenId: null,
      amountRaw: BigInt(leg.total.value),
      amountDecimal: legAmount,
      priceUsdAtTime: priceUsd,
      usdValue,
      gasFeeWei: null,
      blockNumber: Number(tx.block_number),
      timestamp,
    });
  }

  const lpPriceUsd = anyUnpriced ? null : underlyingUsdTotal / lpQuantity;
  const lpUsdValue = anyUnpriced ? null : underlyingUsdTotal;

  liquidityTxHashes.add(tx.hash.toLowerCase());
  rows.push(...underlyingRows, {
    trackedWallet,
    txHash: tx.hash,
    logIndex: -(2000 + Number(lpLeg.log_index || 0)),
    direction: isMint ? "in" : "out",
    counterpartyAddress: poolLc,
    isSelfTransfer: false,
    isCex: false,
    assetType: "erc20",
    tokenAddress: poolLc,
    tokenId: null,
    amountRaw: BigInt(lpLeg.total.value),
    amountDecimal: lpQuantity,
    priceUsdAtTime: lpPriceUsd,
    usdValue: lpUsdValue,
    gasFeeWei: null,
    blockNumber: Number(tx.block_number),
    timestamp,
  });
  return true;
}

/** Detects V3 concentrated-liquidity position activity (mint/increase/decrease/collect) on the
 * canonical NonfungiblePositionManager — same per-tx log-fetch approach as detectAndRecordSwap/
 * detectAndRecordLiquidityEvent, only checked once both of those have already ruled the tx out (a
 * V3 position tx never also carries a V2 Mint/Burn or a Swap log). See this file's own V3 header
 * comment above (near POSITION_MANAGER_ADDRESS) for the confirmed on-chain mechanics this relies on
 * and the pricing/correlation design this implements.
 *
 * A single tx can carry MULTIPLE of these logs at once — a router's multicall commonly bundles
 * decreaseLiquidity()+collect() together (the standard "remove liquidity" flow), or
 * increaseLiquidity()+collect() to also grab accrued fees while topping up — so every Increase/
 * Decrease/Collect log found is processed, not just the first, with same-tx Decrease+Collect pairs
 * correlated by tokenId (decreases are processed first so every collect can see them). */
async function detectAndRecordV3PositionEvent(trackedWallet, walletLc, tx, tokenTransfers, v3TxHashes, rows, priorityAssets) {
  let logsPage;
  try {
    logsPage = await fetchPage(`/transactions/${tx.hash}/logs`, null);
  } catch (err) {
    console.warn(`⚠️  Ingestion: could not fetch logs for tx ${tx.hash}, skipping V3 position detection for it:`, err.message);
    return false;
  }
  const items = logsPage.items || [];
  const onPositionManager = (l) => String(l.address?.hash || l.address).toLowerCase() === POSITION_MANAGER_ADDRESS;
  const increaseLogs = items.filter((l) => onPositionManager(l) && (l.topics || [])[0] === V3_INCREASE_TOPIC);
  const decreaseLogs = items.filter((l) => onPositionManager(l) && (l.topics || [])[0] === V3_DECREASE_TOPIC);
  const collectLogs = items.filter((l) => onPositionManager(l) && (l.topics || [])[0] === V3_COLLECT_TOPIC);
  if (increaseLogs.length === 0 && decreaseLogs.length === 0 && collectLogs.length === 0) return false;

  const timestamp = new Date(tx.timestamp);
  let recorded = false;

  function parseArgs(eventName, log) {
    try {
      const realTopics = (log.topics || []).filter((t) => t != null); // see detectAndRecordSwap's own comment on Blockscout's padded topics array
      return V3_IFACE.parseLog({ topics: realTopics, data: log.data }).args;
    } catch {
      return null;
    }
  }

  // Increase (mint or top-up): dispose the real token0/token1 pulled from the wallet, acquire that
  // much more `liquidity` of the position lot. Requires an actual wallet->pool transfer leg for
  // each nonzero side (a position can be single-sided, minted entirely out of range) — same
  // "confirm against a real transfer, decline rather than guess if it's not there" posture as V2
  // LP detection above, generalized to let a zero-amount side simply have no leg to require at all.
  for (const log of increaseLogs) {
    const args = parseArgs("IncreaseLiquidity", log);
    if (!args) continue;
    const tokenId = args.tokenId;
    const tokenIdStr = tokenId.toString();
    const liquidity = BigInt(args.liquidity);
    if (liquidity <= 0n) continue;

    const posTokens = await getV3PositionTokens(tokenId);
    if (!posTokens) continue;
    const { token0, token1, fee } = posTokens;
    const poolLc = await getV3PoolAddress(token0, token1, fee);
    if (!poolLc) continue;

    const sides = [
      [token0, BigInt(args.amount0)],
      [token1, BigInt(args.amount1)],
    ];
    const legs = [];
    let declined = false;
    for (const [tokenAddr, amountRaw] of sides) {
      if (amountRaw === 0n) continue;
      const leg = tokenTransfers.find((t) => {
        if (String(t.token?.address).toLowerCase() !== tokenAddr) return false;
        return String(t.from?.hash).toLowerCase() === walletLc && String(t.to?.hash).toLowerCase() === poolLc;
      });
      if (!leg) {
        declined = true;
        break;
      }
      legs.push({ tokenAddr, leg });
    }
    if (declined || legs.length === 0) continue;

    let underlyingUsdTotal = 0;
    let anyUnpriced = false;
    const underlyingRows = [];
    for (const { tokenAddr, leg } of legs) {
      const legAmount = weiToDecimal(BigInt(leg.total.value), Number(leg.token.decimals));
      const priceUsd = await priceOrNull(tokenAddr, timestamp, priorityAssets);
      const usdValue = priceUsd != null ? legAmount * priceUsd : null;
      if (usdValue == null) anyUnpriced = true;
      else underlyingUsdTotal += usdValue;
      underlyingRows.push({
        trackedWallet,
        txHash: tx.hash,
        logIndex: -(4000 + Number(leg.log_index || 0)), // distinct sentinel range from every other synthetic-row source in this file
        direction: "out",
        counterpartyAddress: poolLc,
        isSelfTransfer: false,
        isCex: false,
        assetType: "erc20",
        tokenAddress: tokenAddr,
        tokenId: null,
        amountRaw: BigInt(leg.total.value),
        amountDecimal: legAmount,
        priceUsdAtTime: priceUsd,
        usdValue,
        gasFeeWei: null,
        blockNumber: Number(tx.block_number),
        timestamp,
      });
    }

    const liquidityQty = Number(liquidity);
    const positionUsdValue = anyUnpriced ? null : underlyingUsdTotal;
    const positionPriceUsd = anyUnpriced ? null : underlyingUsdTotal / liquidityQty;

    v3TxHashes.add(tx.hash.toLowerCase());
    rows.push(...underlyingRows, {
      trackedWallet,
      txHash: tx.hash,
      logIndex: -(4000 + Number(log.index ?? 0)),
      direction: "in",
      counterpartyAddress: POSITION_MANAGER_ADDRESS,
      isSelfTransfer: false,
      isCex: false,
      assetType: "erc20",
      tokenAddress: v3PositionAssetKey(tokenIdStr),
      tokenId: null,
      amountRaw: liquidity,
      amountDecimal: liquidityQty,
      priceUsdAtTime: positionPriceUsd,
      usdValue: positionUsdValue,
      gasFeeWei: null,
      blockNumber: Number(tx.block_number),
      timestamp,
    });
    recorded = true;
  }

  // Decrease: position-lot disposal ONLY (see this file's own V3 header comment on why the
  // underlying-token acquisition is deferred to Collect, not recorded here) — proceeds priced from
  // the event's own amount0/amount1 (the real value released by the pool's burn(), confirmed
  // reliable even though no transfer has happened yet). Recorded into decreaseByTokenId so a
  // same-tx Collect below can find it.
  const decreaseByTokenId = new Map(); // tokenIdStr -> { token0, token1, amount0Raw, amount1Raw, priceUsd0, priceUsd1 }
  for (const log of decreaseLogs) {
    const args = parseArgs("DecreaseLiquidity", log);
    if (!args) continue;
    const tokenId = args.tokenId;
    const tokenIdStr = tokenId.toString();
    const liquidity = BigInt(args.liquidity);
    if (liquidity <= 0n) continue;

    const posTokens = await getV3PositionTokens(tokenId);
    if (!posTokens) continue;
    const { token0, token1 } = posTokens;
    const amount0Raw = BigInt(args.amount0);
    const amount1Raw = BigInt(args.amount1);

    let underlyingUsdTotal = 0;
    let anyUnpriced = false;
    let priceUsd0 = null;
    let priceUsd1 = null;
    for (const [tokenAddr, amountRaw, setPrice] of [
      [token0, amount0Raw, (p) => (priceUsd0 = p)],
      [token1, amount1Raw, (p) => (priceUsd1 = p)],
    ]) {
      if (amountRaw === 0n) continue;
      const decimals = await getTokenDecimalsCached(tokenAddr);
      const legAmount = weiToDecimal(amountRaw, decimals);
      const priceUsd = await priceOrNull(tokenAddr, timestamp, priorityAssets);
      setPrice(priceUsd);
      const usdValue = priceUsd != null ? legAmount * priceUsd : null;
      if (usdValue == null) anyUnpriced = true;
      else underlyingUsdTotal += usdValue;
    }

    const liquidityQty = Number(liquidity);
    const proceedsUsd = anyUnpriced ? null : underlyingUsdTotal;

    v3TxHashes.add(tx.hash.toLowerCase());
    rows.push({
      trackedWallet,
      txHash: tx.hash,
      logIndex: -(4000 + Number(log.index ?? 0)),
      direction: "out",
      counterpartyAddress: POSITION_MANAGER_ADDRESS,
      isSelfTransfer: false,
      isCex: false,
      assetType: "erc20",
      tokenAddress: v3PositionAssetKey(tokenIdStr),
      tokenId: null,
      amountRaw: liquidity,
      amountDecimal: liquidityQty,
      priceUsdAtTime: proceedsUsd != null ? proceedsUsd / liquidityQty : null,
      usdValue: proceedsUsd,
      gasFeeWei: null,
      blockNumber: Number(tx.block_number),
      timestamp,
    });
    recorded = true;

    decreaseByTokenId.set(tokenIdStr, { token0, token1, amount0Raw, amount1Raw, priceUsd0, priceUsd1 });
  }

  // Collect: the actual underlying-token acquisition. Split against any same-tx decrease for the
  // same tokenId (see this file's own V3 header comment) — the correlated portion is priced at that
  // decrease's own per-unit value (a value-neutral position -> tokens conversion, not a fresh gain/
  // loss purely from the decrease-vs-collect timing gap); anything beyond it is zero-cost-basis fee
  // income, matching the farm/staking reward convention elsewhere in this file exactly (an explicit
  // 0, not a null left to fall back through transferToEvent's own `?? 0` — that fallback exists for
  // "unknown", not "deliberately free", and this is deliberate).
  for (const log of collectLogs) {
    const args = parseArgs("Collect", log);
    if (!args) continue;
    const tokenId = args.tokenId;
    const tokenIdStr = tokenId.toString();
    const amount0Raw = BigInt(args.amount0);
    const amount1Raw = BigInt(args.amount1);
    if (amount0Raw === 0n && amount1Raw === 0n) continue;

    const posTokens = await getV3PositionTokens(tokenId);
    if (!posTokens) continue;
    const { token0, token1 } = posTokens;
    const matching = decreaseByTokenId.get(tokenIdStr);

    const collectRows = [];
    for (const [tokenAddr, collectedRaw, matchedRaw, matchedPriceUsd] of [
      [token0, amount0Raw, matching?.amount0Raw ?? 0n, matching?.priceUsd0 ?? null],
      [token1, amount1Raw, matching?.amount1Raw ?? 0n, matching?.priceUsd1 ?? null],
    ]) {
      if (collectedRaw === 0n) continue;
      const decimals = await getTokenDecimalsCached(tokenAddr);
      const principalRaw = collectedRaw < matchedRaw ? collectedRaw : matchedRaw;
      const feeRaw = collectedRaw - principalRaw;

      if (principalRaw > 0n) {
        const principalAmount = weiToDecimal(principalRaw, decimals);
        collectRows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -(4000 + Number(log.index ?? 0)) - (tokenAddr === token0 ? 1 : 2),
          direction: "in",
          counterpartyAddress: POSITION_MANAGER_ADDRESS,
          isSelfTransfer: false,
          isCex: false,
          assetType: "erc20",
          tokenAddress: tokenAddr,
          tokenId: null,
          amountRaw: principalRaw,
          amountDecimal: principalAmount,
          priceUsdAtTime: matchedPriceUsd,
          usdValue: matchedPriceUsd != null ? principalAmount * matchedPriceUsd : null,
          gasFeeWei: null,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }
      if (feeRaw > 0n) {
        const feeAmount = weiToDecimal(feeRaw, decimals);
        collectRows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -(4000 + Number(log.index ?? 0)) - (tokenAddr === token0 ? 3 : 4),
          direction: "in",
          counterpartyAddress: POSITION_MANAGER_ADDRESS,
          isSelfTransfer: false,
          isCex: false,
          assetType: "erc20",
          tokenAddress: tokenAddr,
          tokenId: null,
          amountRaw: feeRaw,
          amountDecimal: feeAmount,
          priceUsdAtTime: 0, // deliberate zero cost basis -- LP fee income, same convention as farm/staking rewards
          usdValue: 0,
          gasFeeWei: null,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }
    }
    if (collectRows.length === 0) continue;

    v3TxHashes.add(tx.hash.toLowerCase());
    rows.push(...collectRows);
    recorded = true;
  }

  return recorded;
}

/** Walks /addresses/{wallet}/transactions exactly once, doing BOTH swap detection and gas/plain-
 * native-transfer extraction in the same per-tx pass. These used to be two entirely separate full
 * walks of this same endpoint (one in a since-removed ingestSwaps, one here) — pure waste, since
 * whether a given tx is a swap never depends on any *other* tx, so both can be decided together
 * with no ordering hazard. For a high-activity wallet this endpoint is usually the largest of the
 * three by page count, so halving its walks (on top of removing the duplicate) is where most of
 * this refactor's win comes from. Returns { swapTxHashes, highestBlock } — swapTxHashes (despite
 * the name, kept for the property's external contract — see ingestWalletHistory) also includes
 * every V2 add/remove-liquidity tx hash detectAndRecordLiquidityEvent found, unioned in before
 * returning; both need the exact same downstream treatment (excluded from the plain-transfer walks,
 * fed to ingestInternalTransactions/ingestTokenTransfers below, which still run after this
 * completes since they filter on the now-complete set). */
async function ingestTransactionsGasAndSwaps(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, priorityAssets) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  const swapTxHashes = new Set();
  const swapRows = [];
  const liquidityTxHashes = new Set();
  const v3TxHashes = new Set();
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/transactions`, stopAtBlock, async (items) => {
    for (const tx of items) {
      highestBlock = Math.max(highestBlock, Number(tx.block_number));
      const fromLc = String(tx.from?.hash || "").toLowerCase();
      const toLc = String(tx.to?.hash || "").toLowerCase();
      const timestamp = new Date(tx.timestamp);

      // Only worth checking transactions that are actually contract interactions with token
      // transfers attached — Blockscout's /transactions items already embed a token_transfers
      // array per tx (confirmed live), which is exactly the filter needed here without a second
      // per-tx fetch for every plain ETN send.
      const tokenTransfers = tx.token_transfers || [];
      const isContractCallWithTransfers = tokenTransfers.length > 0 && tx.to?.is_contract;
      const isSwap = isContractCallWithTransfers
        ? await detectAndRecordSwap(trackedWallet, walletLc, tx, tokenTransfers, swapTxHashes, swapRows, priorityAssets)
        : false;
      // A real add/remove-liquidity tx never also has a Swap log, so this is only worth checking
      // once swap detection has already ruled it out — same reasoning/precondition as the swap
      // check itself.
      const isLiquidityEvent =
        !isSwap && isContractCallWithTransfers
          ? await detectAndRecordLiquidityEvent(trackedWallet, walletLc, tx, tokenTransfers, liquidityTxHashes, rows, priorityAssets)
          : false;
      // Same precondition as the V2 LP check above — a tx already classified as a swap or a V2 LP
      // event never also carries V3 position-manager logs, so this is only worth checking once both
      // have ruled it out.
      const isV3PositionEvent =
        !isSwap && !isLiquidityEvent && isContractCallWithTransfers
          ? await detectAndRecordV3PositionEvent(trackedWallet, walletLc, tx, tokenTransfers, v3TxHashes, rows, priorityAssets)
          : false;

      // Gas is only ever charged to whoever actually sent the transaction.
      if (fromLc === walletLc && tx.gas_used && tx.gas_price) {
        const gasFeeWei = BigInt(tx.gas_used) * BigInt(tx.gas_price);
        rows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -1,
          direction: "out",
          counterpartyAddress: toLc || walletLc,
          isSelfTransfer: false, // gas is never a self-transfer — it's genuinely spent
          isCex: false,
          assetType: "native",
          tokenAddress: null,
          tokenId: null,
          amountRaw: 0n, // this row represents ONLY the gas fee, not a value transfer — see the plain-ETN-value row below when value > 0
          amountDecimal: 0,
          priceUsdAtTime: null,
          usdValue: null,
          gasFeeWei,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }

      // Plain top-level native ETN transfer (tx.value), separate from the gas-fee row above.
      const value = BigInt(tx.value || "0");
      if (value > 0n && (fromLc === walletLc || toLc === walletLc) && fromLc !== toLc) {
        if (isSwap || isLiquidityEvent || isV3PositionEvent) continue; // recorded via swap_trades or as decomposed liquidity/position legs instead, not as a plain transfer
        const direction = fromLc === walletLc ? "out" : "in";
        const counterparty = direction === "out" ? toLc : fromLc;
        const isSelf = selfOwnedSet.has(counterparty);
        // cexAddressSet is loaded once in ingestWalletHistory, not queried per row — was previously
        // a live Supabase round-trip (isCexAddress) for every non-self transfer, which for a
        // high-activity wallet meant thousands of individual DB calls stacked on top of the
        // Blockscout pagination itself.
        const isCex = !isSelf && cexAddressSet.has(counterparty);
        const priceUsd = await priceOrNull("NATIVE", timestamp);
        rows.push({
          trackedWallet,
          txHash: tx.hash,
          logIndex: -2, // distinct sentinel from the gas row's -1, since both can exist for the same tx_hash
          direction,
          counterpartyAddress: counterparty,
          isSelfTransfer: isSelf,
          isCex,
          assetType: "native",
          tokenAddress: null,
          tokenId: null,
          amountRaw: value,
          amountDecimal: weiToDecimal(value),
          priceUsdAtTime: priceUsd,
          usdValue: priceUsd != null ? weiToDecimal(value) * priceUsd : null,
          gasFeeWei: null,
          blockNumber: Number(tx.block_number),
          timestamp,
        });
      }
    }
  }, "transactions");

  if (rows.length > 0) await insertTransfers(rows);
  if (swapRows.length > 0) await insertSwapTrades(swapRows);
  for (const h of liquidityTxHashes) swapTxHashes.add(h); // see this function's own doc comment on why these share one exclusion set
  for (const h of v3TxHashes) swapTxHashes.add(h); // same reasoning — V3 position tx hashes need the exact same downstream exclusion treatment
  return { swapTxHashes, highestBlock };
}

/** Walks /addresses/{wallet}/internal-transactions — ETN moved by contract calls, invisible to
 * both the plain transaction list and eth_getLogs. Independent of ingestTokenTransfers below (each
 * only touches its own endpoint/rows), so the caller runs the two concurrently.
 * `excludeTxHashes` — swap AND DeFi farm/staking transaction hashes (see ingestWalletHistory's own
 * comment on why both, not just swaps) — a tx already recorded via swap_trades/defi_activity must
 * never ALSO show up here as a plain transfer of the same underlying value. */
async function ingestInternalTransactions(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, excludeTxHashes) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/internal-transactions`, stopAtBlock, async (items) => {
    for (const itx of items) {
      highestBlock = Math.max(highestBlock, Number(itx.block_number));
      if (itx.success === false) continue;
      const fromLc = String(itx.from?.hash || "").toLowerCase();
      const toLc = String(itx.to?.hash || "").toLowerCase();
      const value = BigInt(itx.value || "0");
      if (value === 0n || fromLc === toLc) continue;
      if (fromLc !== walletLc && toLc !== walletLc) continue;
      if (excludeTxHashes.has(String(itx.transaction_hash).toLowerCase())) continue;

      const timestamp = new Date(itx.timestamp);
      const direction = fromLc === walletLc ? "out" : "in";
      const counterparty = direction === "out" ? toLc : fromLc;
      const isSelf = selfOwnedSet.has(counterparty);
      const isCex = !isSelf && cexAddressSet.has(counterparty);
      const priceUsd = await priceOrNull("NATIVE", timestamp);
      rows.push({
        trackedWallet,
        txHash: itx.transaction_hash,
        logIndex: -(1000 + Number(itx.index || 0)), // internal-tx index, offset well clear of -1/-2 sentinels above
        direction,
        counterpartyAddress: counterparty,
        isSelfTransfer: isSelf,
        isCex,
        assetType: "native",
        tokenAddress: null,
        tokenId: null,
        amountRaw: value,
        amountDecimal: weiToDecimal(value),
        priceUsdAtTime: priceUsd,
        usdValue: priceUsd != null ? weiToDecimal(value) * priceUsd : null,
        gasFeeWei: null,
        blockNumber: Number(itx.block_number),
        timestamp,
      });
    }
  }, "internal-transactions");

  if (rows.length > 0) await insertTransfers(rows);
  return highestBlock;
}

/** Walks /addresses/{wallet}/token-transfers — ERC20/721/1155 in/out. Independent of
 * ingestInternalTransactions above, so the caller runs the two concurrently.
 * `excludeTxHashes` — see ingestInternalTransactions' own comment on this same parameter. */
async function ingestTokenTransfers(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, excludeTxHashes, priorityAssets) {
  const walletLc = trackedWallet.toLowerCase();
  const rows = [];
  let highestBlock = stopAtBlock ?? -1;

  await walkAllPages(`/addresses/${trackedWallet}/token-transfers`, stopAtBlock, async (items) => {
    for (const tt of items) {
      highestBlock = Math.max(highestBlock, Number(tt.block_number));
      if (excludeTxHashes.has(String(tt.transaction_hash).toLowerCase())) continue;

      const fromLc = String(tt.from?.hash || "").toLowerCase();
      const toLc = String(tt.to?.hash || "").toLowerCase();
      if (fromLc === toLc) continue;
      const direction = fromLc === walletLc ? "out" : "in";
      const counterparty = direction === "out" ? toLc : fromLc;
      const isSelf = selfOwnedSet.has(counterparty);
      const isCex = !isSelf && cexAddressSet.has(counterparty);

      const timestamp = new Date(tt.timestamp);
      const tokenAddress = tt.token?.address;
      const tokenType = tt.token?.type; // "ERC-20" | "ERC-721" | "ERC-1155" — confirmed live shape

      // A V3 position IS an ERC-721 on-chain (see this file's own V3 header comment near
      // POSITION_MANAGER_ADDRESS), so Blockscout reports its mint/transfer/burn here exactly like
      // any collectible NFT's Transfer log. Normally that's harmless — detectAndRecordV3PositionEvent
      // already recorded the position as its own erc20-typed composite-key event and folded the tx
      // hash into swapTxHashes/excludeTxHashes above, so this whole tx never reaches this loop body.
      // But detection silently DECLINES per-position (not per-tx) on a failed getV3PositionTokens/
      // pool lookup, an RPC hiccup, or a missing matching leg (see its own declined/`continue`
      // branches) — and when it does, this tx's hash is never added to v3TxHashes, so its token
      // transfers land here uninterrupted. Confirmed live: that let the position-manager's own mint
      // Transfer fall through as a genuine "erc721" row, which buildNftEvents then treated as a
      // collectible NFT purchase — matching the SAME underlying token0/token1 legs meant for the LP
      // deposit as its "payment leg" (buildNftEvents has no way to tell those apart from a real
      // same-tx NFT sale payment). That's what inflated NFT PnL's cost basis with real LP capital
      // that was never spent on an NFT at all. So this is skipped unconditionally here — a V3
      // position must NEVER be treated as a collectible NFT, whether or not its own dedicated
      // detection above happened to recognize the tx.
      if (String(tokenAddress).toLowerCase() === POSITION_MANAGER_ADDRESS) continue;

      if (tokenType === "ERC-721" || tokenType === "ERC-1155") {
        // NFTs have no `total.value`/decimals at all (confirmed live: total is
        // { token_id, token_instance }, decimals is null) — previously this fell through to the
        // ERC-20 branch below, BigInt(undefined || "0") silently produced amountRaw=0, and every
        // amount_raw=0 filter elsewhere in this codebase (flows, transaction history) then dropped
        // the row entirely. Each NFT is a distinct, individually-cost-tracked asset (see
        // fifoLotEngine.js's "tokenAddress:tokenId" lot-key convention), not a fungible quantity —
        // ERC-1155 IS technically semi-fungible (total.value can be >1 of the same tokenId), so its
        // quantity is read from total.value when present; ERC-721 is always exactly 1.
        const tokenId = tt.total?.token_id != null ? String(tt.total.token_id) : null;
        const quantity = tokenType === "ERC-1155" && tt.total?.value ? BigInt(tt.total.value) : 1n;
        rows.push({
          trackedWallet,
          txHash: tt.transaction_hash,
          logIndex: Number(tt.log_index),
          direction,
          counterpartyAddress: counterparty,
          isSelfTransfer: isSelf,
          isCex,
          assetType: tokenType === "ERC-721" ? "erc721" : "erc1155",
          tokenAddress,
          tokenId,
          amountRaw: quantity,
          amountDecimal: Number(quantity),
          priceUsdAtTime: null, // NFTs have no fungible-market price feed — cost basis/proceeds come from correlated same-tx payments instead, see pnlStatementGenerator.js's buildNftEvents
          usdValue: null,
          gasFeeWei: null,
          blockNumber: Number(tt.block_number),
          timestamp,
        });
        continue;
      }

      const decimals = Number(tt.token?.decimals ?? 18);
      const amountRaw = BigInt(tt.total?.value || "0");
      const priceUsd = await priceOrNull(tokenAddress, timestamp, priorityAssets);
      const amountDecimal = weiToDecimal(amountRaw, decimals);

      rows.push({
        trackedWallet,
        txHash: tt.transaction_hash,
        logIndex: Number(tt.log_index),
        direction,
        counterpartyAddress: counterparty,
        isSelfTransfer: isSelf,
        isCex,
        assetType: "erc20",
        tokenAddress,
        tokenId: null,
        amountRaw,
        amountDecimal,
        priceUsdAtTime: priceUsd,
        usdValue: priceUsd != null ? amountDecimal * priceUsd : null,
        gasFeeWei: null,
        blockNumber: Number(tt.block_number),
        timestamp,
      });
    }
  }, "token-transfers");

  if (rows.length > 0) await insertTransfers(rows);
  return highestBlock;
}

const DEFI_LOG_MIN_CHUNK_SIZE = 50; // matches coreClashBurnWatcher.js's own queryLogsChunked floor
// Bounded worker pool — see queryDefiLogsChunked's own comment. Confirmed live that 8 concurrent
// requests, once the primary's cooldown routes all of them to the secondary at once (see
// rpcProvider.js), was enough to trip a transient 403 from that endpoint (a public node with no
// published rate-limit contract). Lowered to 4 as a real reduction in burst pressure, not a
// guaranteed-safe number — rpcProvider.js's own short retry-on-403 is the actual safety net for
// whatever residual burst pressure remains.
const DEFI_LOG_CONCURRENCY = 4;

/** Fetches one [start, end] window, shrinking ONLY within this window on a "block range too
 * large" error and never touching any other window's size — see queryDefiLogsChunked's own
 * comment for why a shared/global shrink was a real, confirmed-live bug. */
async function fetchDefiLogWindow(provider, topics, start, end) {
  const logs = [];
  let size = end - start + 1;
  let curStart = start;
  while (curStart <= end) {
    const curEnd = Math.min(curStart + size - 1, end);
    try {
      const chunk = await provider.getLogs({ topics, fromBlock: curStart, toBlock: curEnd });
      logs.push(...chunk);
      curStart = curEnd + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
      if (isRangeError && size > DEFI_LOG_MIN_CHUNK_SIZE) {
        size = Math.max(DEFI_LOG_MIN_CHUNK_SIZE, Math.floor(size / 2));
        continue; // retry the same curStart with a smaller window, LOCAL to this window only
      }
      console.warn(`⚠️  DeFi activity scan: getLogs failed for blocks ${curStart}-${curEnd}:`, err.message);
      // A genuinely non-range failure (transient RPC issue) — skipping it just means this range
      // gets picked up again next ingestion run (stopAtBlock only advances once every requested
      // window succeeds — see ingestDefiActivity below).
      throw err;
    }
  }
  return logs;
}

/** Chunked raw eth_getLogs scan across the WHOLE chain (no `address` filter) for one topic-0
 * signature, with the tracked wallet pinned at `walletTopicIndex`. Deliberately not Blockscout's
 * REST pagination (unlike every other walk in this file) — there's no per-wallet Blockscout
 * endpoint for "every log anywhere naming this address in topic N", so this goes straight to the
 * RPC provider instead.
 *
 * Splits [fromBlock, toBlock] into DEFI_LOG_CHUNK_SIZE-sized windows and fetches them through a
 * bounded worker pool (DEFI_LOG_CONCURRENCY concurrent requests), each window independently
 * shrinking-and-retrying on its own "block range too large" error via fetchDefiLogWindow.
 * Confirmed live and fixed two real bugs from an earlier single-cursor sequential version:
 *   1. A shrunk chunk size used to be a single variable shared across the ENTIRE scan, never
 *      reset after a successful call — one unlucky window failing early (e.g. shrinking to the
 *      50-block floor) permanently degraded every later window too, turning a ~782-window scan
 *      into 300,000+ windows. Confirmed live: a real regeneration stalled for 25+ minutes with
 *      zero progress after exactly this happened. Now every window starts fresh at
 *      DEFI_LOG_CHUNK_SIZE regardless of what any other window needed.
 *   2. Windows were fetched one at a time, fully sequential — a wallet's first-ever DeFi scan
 *      covers the chain's entire history (see ingestDefiActivity's stopAtDefiBlock handling), so
 *      that's ~782 sequential round-trips per topic even at the current 20000-block chunk size.
 *      The worker pool below cuts that by roughly DEFI_LOG_CONCURRENCY.
 */
async function queryDefiLogsChunked(provider, topic0, walletTopicIndex, walletTopic, fromBlock, toBlock, label, startedAt) {
  const topics = [];
  topics[0] = topic0;
  topics[walletTopicIndex] = walletTopic;

  const windows = [];
  for (let start = fromBlock; start <= toBlock; start += DEFI_LOG_CHUNK_SIZE) {
    windows.push([start, Math.min(start + DEFI_LOG_CHUNK_SIZE - 1, toBlock)]);
  }
  if (windows.length === 0) return [];

  const results = new Array(windows.length);
  let nextIndex = 0;
  // Unlike walkAllPages' progress logging (an approximation — the true wallet history span isn't
  // knowable up front), this denominator is exact: the window list is built in full before any
  // fetch starts, so completedCount/windows.length is a real % of this topic's scan.
  let completedCount = 0;
  let lastLoggedAt = 0;
  async function worker() {
    while (nextIndex < windows.length) {
      const myIndex = nextIndex++;
      const [start, end] = windows[myIndex];
      results[myIndex] = await fetchDefiLogWindow(provider, topics, start, end);
      completedCount++;
      if (label) {
        const now = Date.now();
        if (now - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
          lastLoggedAt = now;
          const pct = Math.round((completedCount / windows.length) * 100);
          const elapsedSec = Math.round((now - startedAt) / 1000);
          console.log(`📊 [DeFi:${label}] ${completedCount}/${windows.length} windows (~${pct}%) — ${elapsedSec}s elapsed`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DEFI_LOG_CONCURRENCY, windows.length) }, () => worker()));
  return results.flat();
}

/** For every farm_deposit/farm_withdraw row, looks for a same-tx BOLT ERC20 Transfer log matching
 * the expected direction (farmer -> farm contract for a deposit, farm contract -> farmer for a
 * withdrawal that closed the position entirely — see YieldFarm.sol's own withdraw(), which only
 * returns BOLT once farmer.liquidity reaches 0) and merges the amount into that row's rawArgs as
 * amountBoltAdded/amountBoltReturned. One receipt fetch per DISTINCT transaction hash needing it
 * (deduped — a tx can only ever contain one farm_deposit/farm_withdraw log for this wallet), not
 * per row. Most farm deposits/withdrawals never touch BOLT at all (it's an optional multiplier
 * boost) — a tx with no matching Transfer just gets no enrichment, not an error. */
async function enrichFarmRowsWithBolt(provider, rows) {
  const relevant = rows.filter((r) => r.eventType === "farm_deposit" || r.eventType === "farm_withdraw");
  if (relevant.length === 0) return;

  const receiptCache = new Map(); // txHash (lowercase) -> receipt | null
  for (const row of relevant) {
    const txHashLc = row.txHash.toLowerCase();
    if (!receiptCache.has(txHashLc)) {
      try {
        receiptCache.set(txHashLc, await provider.getTransactionReceipt(row.txHash));
      } catch (err) {
        console.warn(`⚠️  DeFi activity scan: could not fetch receipt for ${row.txHash} (BOLT correlation skipped):`, err.message);
        receiptCache.set(txHashLc, null);
      }
    }
    const receipt = receiptCache.get(txHashLc);
    if (!receipt) continue;

    const farmerLc = row.rawArgs.farmer?.toLowerCase();
    const contractLc = row.contractAddress.toLowerCase();
    const boltTransfer = receipt.logs.find((l) => {
      if (String(l.address).toLowerCase() !== BOLT_TOKEN_ADDRESS) return false;
      if ((l.topics || [])[0] !== ERC20_TRANSFER_TOPIC) return false;
      let parsed;
      try {
        parsed = ERC20_TRANSFER_IFACE.parseLog(l);
      } catch {
        return false;
      }
      const from = String(parsed.args.from).toLowerCase();
      const to = String(parsed.args.to).toLowerCase();
      return row.eventType === "farm_deposit" ? from === farmerLc && to === contractLc : from === contractLc && to === farmerLc;
    });
    if (!boltTransfer) continue;

    const amount = ERC20_TRANSFER_IFACE.parseLog(boltTransfer).args.value.toString();
    if (row.eventType === "farm_deposit") row.rawArgs.amountBoltAdded = amount;
    else row.rawArgs.amountBoltReturned = amount;
  }
}

/** Scans for yield-farm/staking activity involving `trackedWallet` — see DEFI_IFACE's own comment
 * for why this is topic-based (works for any contract reusing either template) rather than a
 * hardcoded address list. Returns `{ highestBlock, defiTxHashes }` — highestBlock is the same
 * "resumable cursor" contract as every other ingest* function in this file; defiTxHashes is every
 * transaction hash a DeFi event was found in, fed back into ingestWalletHistory's exclusion set
 * (same role as ingestTransactionsGasAndSwaps' own swapTxHashes) so a farm/stake deposit's own
 * token legs — ordinary ERC20 transferFrom/transfer calls under the hood — never ALSO get ingested
 * as plain transfers alongside the DeFi-specific event for the exact same amount. Confirmed live
 * this exclusion was previously missing entirely: every farm deposit/withdrawal and staking
 * action was being counted twice in the FIFO ledger, once via buildDefiFarmEvents and once via the
 * generic transfer walk. */
async function ingestDefiActivity(trackedWallet, stopAtBlock) {
  const provider = createRpcProvider();
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = (stopAtBlock ?? -1) + 1;
  if (fromBlock > latestBlock) return { highestBlock: stopAtBlock ?? -1, defiTxHashes: new Set() };

  const startedAt = Date.now();
  if (stopAtBlock == null) {
    console.log(`📥 DeFi activity cold-start scan for ${trackedWallet}: blocks ${fromBlock}-${latestBlock} (${(latestBlock - fromBlock + 1).toLocaleString()} blocks) started at ${new Date(startedAt).toISOString()}`);
  }

  const walletTopic = ethers.zeroPadValue(trackedWallet, 32);
  const [farmDeposits, farmIncreases, farmWithdrawals, staked, withdrawn, rewards] = await Promise.all([
    queryDefiLogsChunked(provider, FARM_DEPOSIT_TOPIC, FARM_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "FarmDeposit", startedAt),
    queryDefiLogsChunked(provider, FARM_INCREASE_TOPIC, FARM_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "FarmIncrease", startedAt),
    queryDefiLogsChunked(provider, FARM_WITHDRAW_TOPIC, FARM_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "FarmWithdrawl", startedAt),
    queryDefiLogsChunked(provider, CORE_STAKED_TOPIC, STAKING_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "CoreStaked", startedAt),
    queryDefiLogsChunked(provider, CORE_WITHDRAWN_TOPIC, STAKING_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "CoreWithdrawn", startedAt),
    queryDefiLogsChunked(provider, REWARD_PAID_TOPIC, STAKING_EVENT_WALLET_TOPIC_INDEX, walletTopic, fromBlock, latestBlock, "RewardPaid", startedAt),
  ]);

  const allLogs = [...farmDeposits, ...farmIncreases, ...farmWithdrawals, ...staked, ...withdrawn, ...rewards];
  if (allLogs.length === 0) return { highestBlock: latestBlock, defiTxHashes: new Set() };

  const uniqueBlocks = [...new Set(allLogs.map((l) => l.blockNumber))];
  const blockTimestamps = new Map();
  await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await provider.getBlock(blockNumber);
        blockTimestamps.set(blockNumber, block ? new Date(block.timestamp * 1000) : null);
      } catch (err) {
        console.warn(`⚠️  DeFi activity scan: failed to fetch timestamp for block ${blockNumber}:`, err.message);
        blockTimestamps.set(blockNumber, null);
      }
    })
  );

  const rows = [];
  for (const log of allLogs) {
    const timestamp = blockTimestamps.get(log.blockNumber);
    if (!timestamp) continue; // couldn't get a real timestamp — skip rather than fake one, same convention as every other ingest* function
    let parsed;
    try {
      parsed = DEFI_IFACE.parseLog(log);
    } catch (err) {
      console.warn(`⚠️  DeFi activity scan: could not decode log in tx ${log.transactionHash}:`, err.message);
      continue;
    }
    // FarmIncrease maps to the SAME 'farm_deposit' event_type as FarmDeposit — both are inflows
    // into the farmer's position (a brand-new one vs. topping up an existing one), identical for
    // FIFO/cost-basis purposes; buildDefiFarmEvents in pnlEventBuilder.js doesn't need to (and
    // doesn't) distinguish them.
    const eventType = {
      FarmDeposit: "farm_deposit",
      FarmIncrease: "farm_deposit",
      FarmWithdrawl: "farm_withdraw",
      CoreStaked: "core_staked",
      CoreWithdrawn: "core_withdrawn",
      RewardPaid: "reward_paid",
    }[parsed.name];
    const rawArgs = {};
    for (const frag of parsed.fragment.inputs) {
      const v = parsed.args[frag.name];
      rawArgs[frag.name] = typeof v === "bigint" ? v.toString() : v;
    }
    rows.push({
      trackedWallet,
      txHash: log.transactionHash,
      logIndex: log.index,
      contractAddress: log.address,
      eventType,
      farmId: rawArgs.farmId != null ? rawArgs.farmId : null,
      rawArgs,
      blockNumber: log.blockNumber,
      timestamp,
    });
  }

  // BOLT correlation only ever matters for the two event types deposit()/withdraw() legs can
  // actually touch (see enrichFarmRowsWithBolt's own comment) — skipped entirely, no receipt
  // fetches at all, for a wallet whose DeFi activity is only staking/rewards.
  await enrichFarmRowsWithBolt(provider, rows);

  if (rows.length > 0) await insertDefiActivity(rows);
  const defiTxHashes = new Set(rows.map((r) => r.txHash.toLowerCase()));
  return { highestBlock: latestBlock, defiTxHashes };
}

// Concurrent callers ingesting the SAME wallet at once (e.g. coreTierDemoRouter.js's PnL and NFT
// PnL sections, computed together in one Promise.all) used to each run their own full Blockscout
// walk in parallel — genuinely duplicated work (confirmed live: every ingestion log line for the
// demo's 3 wallets appeared twice), and racing writes to wallet_ingestion_state's own cursor. Keyed
// by lowercased wallet address; whichever call arrives first does the real work, every concurrent
// caller for that same wallet just awaits its result instead of starting a second walk. Cleared as
// soon as the in-flight call settles (success or failure) so the NEXT call — a later page load, a
// resumed ingestion — always starts fresh rather than reusing a stale promise.
const inFlightIngestions = new Map(); // walletLc -> Promise

/**
 * Ingests (or backfills) `trackedWallet`'s on-chain history. `selfOwnedAddresses` are the user's
 * other addresses, used to flag self-transfers (excluded from FIFO disposal — see fifoLotEngine.js).
 * Safe to call repeatedly for the same wallet — always resumes from wallet_ingestion_state's
 * last_ingested_block rather than re-scanning from scratch. Also safe to call CONCURRENTLY for the
 * same wallet — see inFlightIngestions above; concurrent calls share one real ingestion run rather
 * than each starting their own.
 *
 * `priorityAssets` (optional Set of lowercased token addresses) — see priceOrNull's own comment.
 * Omit/pass null for full, complete pricing (generateStatement always does this). Rows for a
 * non-priority token get inserted with a null price for now; backfillDeferredPrices below re-prices
 * them later without touching this walk at all.
 */
export async function ingestWalletHistory(trackedWallet, selfOwnedAddresses = [], priorityAssets = null) {
  const walletLc = trackedWallet.toLowerCase();
  const existing = inFlightIngestions.get(walletLc);
  if (existing) return existing;

  const promise = doIngestWalletHistory(trackedWallet, selfOwnedAddresses, priorityAssets).finally(() => {
    if (inFlightIngestions.get(walletLc) === promise) inFlightIngestions.delete(walletLc);
  });
  inFlightIngestions.set(walletLc, promise);
  return promise;
}

async function doIngestWalletHistory(trackedWallet, selfOwnedAddresses = [], priorityAssets = null) {
  const selfOwnedSet = new Set([trackedWallet.toLowerCase(), ...selfOwnedAddresses.map((a) => a.toLowerCase())]);
  // Loaded once per ingestion run rather than queried per-row (see cexAddressSet's own comment
  // below at its call sites) — the list itself is small and manually-maintained (see
  // cexAddresses.js), so this is one query however many thousands of transfer rows follow.
  const [state, cexAddressList] = await Promise.all([getIngestionState(trackedWallet), listCexAddresses()]);
  const cexAddressSet = new Set(cexAddressList.map((r) => r.address.toLowerCase()));
  const stopAtBlock = state?.last_ingested_block > 0 ? state.last_ingested_block : null;
  // Deliberately a SEPARATE cursor from stopAtBlock (see migration 006's own comment) — DeFi
  // activity scanning was added after many wallets already had a non-null last_ingested_block from
  // the other four walks, and reusing that shared cursor here would mean ingestDefiActivity only
  // ever looked at blocks after each wallet's PRE-EXISTING checkpoint, silently skipping its entire
  // real DeFi history. A wallet with last_ingested_defi_block still NULL always gets a full
  // cold-start DeFi scan here, regardless of how far its ordinary ingestion has already progressed.
  const stopAtDefiBlock = state?.last_ingested_defi_block > 0 ? state.last_ingested_defi_block : null;

  console.log(`📥 Ingesting history for ${trackedWallet}${stopAtBlock ? ` (resuming after block ${stopAtBlock})` : " (cold start — full history)"}${stopAtDefiBlock == null ? ", DeFi activity cold start" : ""}${priorityAssets ? `, priced fully for ${priorityAssets.size} priority asset(s) — others deferred` : ""}`);

  // /transactions must go first (and complete) — it's the only source of swapTxHashes, which the
  // internal-transactions/token-transfers walks need to correctly skip a swap's legs. DeFi activity
  // scanning has no such dependency (it's a separate topic-based getLogs scan, not a Blockscout
  // REST walk at all — see ingestDefiActivity's own comment), so it runs alongside the
  // /transactions walk from the start rather than waiting for it. Once swapTxHashes is known, the
  // two swap-dependent walks run concurrently with each other too — see each function's own
  // comment for why this whole restructure is deliberate: /transactions used to be walked twice
  // and everything used to run fully sequentially.
  const [{ swapTxHashes, highestBlock: highestFromTx }, { highestBlock: highestFromDefi, defiTxHashes }] = await Promise.all([
    ingestTransactionsGasAndSwaps(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, priorityAssets),
    ingestDefiActivity(trackedWallet, stopAtDefiBlock),
  ]);
  // A farm/stake deposit or withdrawal moves its own underlying tokens via ordinary ERC20
  // transferFrom/transfer calls under the hood — without excluding defiTxHashes here too (same
  // role swapTxHashes already plays for a swap's own legs), those same amounts would ALSO get
  // ingested as plain transfers alongside buildDefiFarmEvents' own DeFi-specific event for the
  // exact same tx, double-counting every farm/stake action in the FIFO ledger. Confirmed live this
  // exclusion was missing entirely before now.
  const excludeTxHashes = new Set([...swapTxHashes, ...defiTxHashes]);
  const [highestFromInternal, highestFromTokens] = await Promise.all([
    ingestInternalTransactions(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, excludeTxHashes),
    ingestTokenTransfers(trackedWallet, selfOwnedSet, cexAddressSet, stopAtBlock, excludeTxHashes, priorityAssets),
  ]);
  const highestBlock = Math.max(highestFromTx, highestFromInternal, highestFromTokens);

  if (highestBlock >= 0 || highestFromDefi >= 0) {
    await upsertIngestionState(trackedWallet, {
      lastIngestedBlock: highestBlock >= 0 ? highestBlock : stopAtBlock,
      coldStartCompletedAt: state?.cold_start_completed_at || new Date(),
      lastIngestedDefiBlock: highestFromDefi >= 0 ? highestFromDefi : null,
    });
  }

  console.log(`📥 Ingestion complete for ${trackedWallet} — caught up to block ${highestBlock}, ${swapTxHashes.size} swap/liquidity event(s) detected`);
}

/**
 * Runs ONLY the DeFi-activity scan — not the full five-way ingestWalletHistory walk — for a caller
 * that needs defi_activity to be reasonably current without paying for (or requiring) a full
 * ingestion. Built for defiPositionValuation.js's live position lookup: Combined Holdings/Total
 * Portfolio Balance (the Portfolio page) has no other reason to ever call ingestWalletHistory at
 * all, so without this, a wallet's open farm/staking positions would only ever surface AFTER the
 * member happened to visit Core Tier PnL or generate a Statement for it — a confusing, silent
 * cross-feature dependency a member browsing Portfolio alone would have no way to know about.
 *
 * Safe to call alongside (before, after, or concurrently with) a real ingestWalletHistory run for
 * the same wallet: uses the exact same last_ingested_defi_block cursor that advances, and never
 * touches last_ingested_block/cold_start_completed_at (passed through unchanged from whatever's
 * already stored) — whichever of the two runs first on a given day, the other picks up from where
 * it left off rather than re-scanning, and neither can regress the other's own cursor.
 */
export async function ensureDefiActivityIngested(trackedWallet) {
  const state = await getIngestionState(trackedWallet);
  const stopAtDefiBlock = state?.last_ingested_defi_block > 0 ? state.last_ingested_defi_block : null;
  const { highestBlock: highestFromDefi } = await ingestDefiActivity(trackedWallet, stopAtDefiBlock);
  if (highestFromDefi >= 0) {
    await upsertIngestionState(trackedWallet, {
      lastIngestedBlock: state?.last_ingested_block ?? null,
      coldStartCompletedAt: state?.cold_start_completed_at || null,
      lastIngestedDefiBlock: highestFromDefi,
    });
  }
}

/**
 * Re-prices every row ingestWalletHistory left with a null price for `trackedWallet` — both
 * deliberately-deferred non-priority assets (see priorityAssets) and any genuine historical
 * lookup failure — using the FULL getHistoricalPriceUsd (bulk-backfilling a never-priced asset as
 * needed), then updates those specific rows in place. Never re-walks Blockscout at all: the rows
 * already exist, only their price columns change.
 *
 * Meant to run in the BACKGROUND after a priority-scoped computeLivePnlSnapshot has already
 * returned its (partial) result to the user — see pnlSnapshotService.js's own comment. Safe to
 * call any time regardless of whether priorityAssets was ever used (e.g. a wallet with a handful
 * of genuinely-failed historical lookups from before this feature existed benefits too) — it just
 * does nothing if there's nothing left to price.
 */
export async function backfillDeferredPrices(trackedWallet) {
  const [transferRows, swapRows] = await Promise.all([
    getUnpricedTransfers(trackedWallet),
    getSwapTradesWithUnpricedLegs(trackedWallet),
  ]);
  if (transferRows.length === 0 && swapRows.length === 0) return;

  console.log(`💰 Backfilling ${transferRows.length} deferred transfer price(s) and ${swapRows.length} swap leg(s) for ${trackedWallet}`);

  for (const row of transferRows) {
    const asset = row.asset_type === "native" ? "NATIVE" : row.token_address;
    try {
      const priceUsd = await getHistoricalPriceUsd(asset, new Date(row.timestamp));
      await setTransferPrice(row.id, priceUsd, Number(row.amount_decimal) * priceUsd);
    } catch (err) {
      console.warn(`⚠️  Deferred-price backfill: still couldn't price ${asset} for transfer ${row.id}:`, err.message);
    }
  }

  for (const row of swapRows) {
    const timestamp = new Date(row.timestamp);
    let priceSold = row.price_usd_sold_leg != null ? Number(row.price_usd_sold_leg) : null;
    let priceBought = row.price_usd_bought_leg != null ? Number(row.price_usd_bought_leg) : null;

    if (priceSold == null) {
      try {
        priceSold = await getHistoricalPriceUsd(row.token_sold_address, timestamp);
      } catch (err) {
        console.warn(`⚠️  Deferred-price backfill: still couldn't price sold leg ${row.token_sold_address} for swap ${row.id}:`, err.message);
      }
    }
    if (priceBought == null) {
      try {
        priceBought = await getHistoricalPriceUsd(row.token_bought_address, timestamp);
      } catch (err) {
        console.warn(`⚠️  Deferred-price backfill: still couldn't price bought leg ${row.token_bought_address} for swap ${row.id}:`, err.message);
      }
    }
    if (priceSold != null || priceBought != null) await setSwapLegPrices(row.id, priceSold, priceBought);
  }

  console.log(`💰 Deferred-price backfill complete for ${trackedWallet}`);
}
