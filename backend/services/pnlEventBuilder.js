// backend/services/pnlEventBuilder.js
//
// Turns raw ingested rows (ingestedTransfers.js, swapTrades.js, defiActivity.js) into
// fifoLotEngine.js's event shape, and values a set of FIFO lots at a point in time — extracted
// VERBATIM from pnlStatementGenerator.js (no logic changes) so pnlSnapshotService.js (the Core
// tier "live PnL" dashboard feature) can build the exact same events and read the exact same
// lots/valuation the PnL Statement product uses, without a second, divergence-prone
// reimplementation. Both callers must produce identical realized/unrealized figures for the same
// wallet/token/timestamp — this file is what makes that a property of sharing code, not of
// keeping two implementations in sync by hand.
//
// pnlStatementGenerator.js itself now imports these from here instead of defining them locally —
// see that file's own header comment.
import { ethers } from "ethers";
import Decimal from "decimal.js";
import { getHistoricalPriceUsd, getCachedHistoricalPriceUsd } from "./pnlPricing.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

// A fixed sentinel string (not an address) standing in for native ETN wherever an "asset" needs a
// single identifying key alongside real token addresses — see formatAssetLabel's exact-match
// check against it in pnlStatementGenerator.js.
export const NATIVE_SENTINEL = "NATIVE";

export function transferToEvent(t) {
  // Lowercased so the same real contract never splits into two different FIFO/aggregation
  // buckets over checksum-vs-lowercase casing inconsistency between data sources (confirmed live:
  // the exact same token showing as two separate rows in the Realized Gains & Losses "By Asset"
  // table, e.g. one bucket's disposals under "0x043faa1b..." and the rest under
  // "0x043fAa1b..."). Guarded so NATIVE_SENTINEL itself (a fixed sentinel string, not an address —
  // see formatAssetLabel's exact-match check against it) is never touched.
  const tokenAddress = t.token_address ? t.token_address.toLowerCase() : NATIVE_SENTINEL;
  const timestamp = new Date(t.timestamp);
  if (t.is_self_transfer) {
    return t.direction === "out"
      ? { kind: "self_out", tokenAddress, txHash: t.tx_hash, timestamp, quantity: t.amount_decimal }
      : { kind: "self_in", tokenAddress, txHash: t.tx_hash, timestamp, quantity: t.amount_decimal, unitCostUsd: t.price_usd_at_time ?? 0 };
  }
  return t.direction === "out"
    ? { kind: "out", tokenAddress, txHash: t.tx_hash, timestamp, quantity: t.amount_decimal, proceedsUsd: t.usd_value ?? 0 }
    : { kind: "in", tokenAddress, txHash: t.tx_hash, timestamp, quantity: t.amount_decimal, unitCostUsd: t.price_usd_at_time ?? 0 };
}

export const NFT_ASSET_TYPES = new Set(["erc721", "erc1155"]);

/** "collectionAddress:tokenId" — the lot key one specific NFT is tracked under everywhere in this
 * file (FIFO lots, formatAssetLabel, collectTokenMetadata). Distinct from a fungible token's plain
 * address specifically so fifoLotEngine.js — which has no NFT-specific code at all, it just keys
 * lots by whatever string it's given — never pools two different NFTs (or an NFT and a same-
 * collection fungible token, if that were ever possible) into one FIFO queue. */
export function nftAssetKey(t) {
  // Same lowercasing reasoning as transferToEvent — an NFT collection address is never native
  // ETN, so this can lowercase unconditionally.
  return `${t.token_address.toLowerCase()}:${t.token_id}`;
}

/** Detects NFT (ERC-721/1155) mint/purchase and sale/transfer-out events by correlating each NFT
 * leg with any other non-NFT leg in the SAME transaction that moved value the opposite direction —
 * the payment for a mint/purchase, or the proceeds of a sale. This is a heuristic, the same
 * category of caveat as ingestSwaps' own same-tx-leg correlation in pnlIngestion.js: it assumes
 * payment and NFT movement happen atomically in one transaction, which covers the common case (a
 * single mint()/buyNow() call) but won't catch a payment that lands in a separate transaction. No
 * same-tx match: cost basis / proceeds is 0 — correct for a genuine free mint/airdrop/gift, but
 * would understate cost basis (or overstate a sale's gain) for a genuinely unmatched paid
 * transaction, so `unmatchedCount` is surfaced on the returned object for the statement to flag.
 *
 * When multiple NFTs are disposed/acquired in ONE transaction against a single shared payment/
 * proceeds leg (e.g. a Seaport batch settlement paying one combined amount), that leg's value is
 * split evenly across every NFT leg sharing it rather than applied in full to each — see the
 * inNftQtyTotal/outNftQtyTotal comment below.
 *
 * Returns { events: FIFO events (kind 'in'/'out'/'self_in'/'self_out', tokenAddress = the NFT's
 * composite key) for every NFT leg, consumedRowIds: Set of row `id`s already turned into one of
 * those events — the caller excludes these from the generic transferToEvent mapping so an NFT leg
 * is never fed into FIFO twice, unmatchedCount }. */
export function buildNftEvents(transfers) {
  const byTx = new Map();
  for (const t of transfers) {
    if (!byTx.has(t.tx_hash)) byTx.set(t.tx_hash, []);
    byTx.get(t.tx_hash).push(t);
  }

  const events = [];
  const consumedRowIds = new Set();
  let unmatchedCount = 0;

  for (const rows of byTx.values()) {
    const nftLegs = rows.filter((r) => NFT_ASSET_TYPES.has(r.asset_type));
    if (nftLegs.length === 0) continue;

    // Multiple NFTs disposed/acquired in ONE transaction (e.g. a Seaport `fulfillAvailableAdvancedOrders`
    // batch settlement) commonly share a SINGLE payment/proceeds leg — the marketplace contract pays
    // out one combined amount (often as one internal transaction), not one per NFT. Both `rows.find()`
    // calls below always resolve to the same first-matching leg regardless of which NFT leg triggered
    // them, so without dividing here, that leg's FULL value would get credited/charged against EACH NFT
    // independently — confirmed live: an 8-NFT batch sale recorded the same proceeds figure against all
    // 8 NFTs instead of splitting the one shared leg across them (8x overstated proceeds). Since the
    // match is leg-independent, every non-self NFT leg in this tx is presumed to share whichever leg it
    // resolves to, so the shared quantity is just every non-self NFT leg's quantity summed per direction.
    const inNftQtyTotal = nftLegs
      .filter((r) => r.direction === "in" && !r.is_self_transfer)
      .reduce((sum, r) => sum + (Number(r.amount_decimal) || 1), 0);
    const outNftQtyTotal = nftLegs
      .filter((r) => r.direction === "out" && !r.is_self_transfer)
      .reduce((sum, r) => sum + (Number(r.amount_decimal) || 1), 0);

    for (const nftLeg of nftLegs) {
      consumedRowIds.add(nftLeg.id);
      const tokenAddress = nftAssetKey(nftLeg);
      const timestamp = new Date(nftLeg.timestamp);
      const quantity = Number(nftLeg.amount_decimal) || 1; // ERC-1155 batch quantity, or 1 for ERC-721

      if (nftLeg.direction === "in") {
        if (nftLeg.is_self_transfer) {
          // No fungible-market price feed exists for an NFT to "reset to" the way a regular
          // token's self_in does (see transferToEvent) — 0 cost basis on this side, same
          // reasoning fifoLotEngine.js's own removeForSelfTransfer comment already documents for
          // why cross-wallet cost-basis continuity is out of scope here.
          events.push({ kind: "self_in", tokenAddress, txHash: nftLeg.tx_hash, timestamp, quantity, unitCostUsd: 0 });
          continue;
        }
        const paymentLeg = rows.find(
          (r) => r !== nftLeg && r.direction === "out" && !NFT_ASSET_TYPES.has(r.asset_type) && Number(r.amount_raw) > 0
        );
        if (!paymentLeg) unmatchedCount++;
        // Divide by the TOTAL quantity across every NFT leg sharing this same matched leg (not just
        // this leg's own quantity) — see the comment above the totals. Reduces to the prior
        // single-NFT-per-tx behavior when inNftQtyTotal === quantity.
        const unitCostUsd = paymentLeg?.usd_value != null ? Number(paymentLeg.usd_value) / inNftQtyTotal : 0;
        events.push({ kind: "in", tokenAddress, txHash: nftLeg.tx_hash, timestamp, quantity, unitCostUsd });
      } else {
        if (nftLeg.is_self_transfer) {
          events.push({ kind: "self_out", tokenAddress, txHash: nftLeg.tx_hash, timestamp, quantity });
          continue;
        }
        const proceedsLeg = rows.find(
          (r) => r !== nftLeg && r.direction === "in" && !NFT_ASSET_TYPES.has(r.asset_type) && Number(r.amount_raw) > 0
        );
        if (!proceedsLeg) unmatchedCount++;
        // proceedsUsd is the TOTAL for this leg's own quantity (fifoLotEngine.js's dispose() divides
        // it internally by `quantity` to get a per-unit figure) — so this leg's fair share of the
        // shared proceeds leg is (this leg's quantity / total shared quantity) of that leg's value.
        // Reduces to the prior single-NFT-per-tx behavior when outNftQtyTotal === quantity.
        const proceedsUsd = proceedsLeg?.usd_value != null ? (Number(proceedsLeg.usd_value) * quantity) / outNftQtyTotal : 0;
        events.push({ kind: "out", tokenAddress, txHash: nftLeg.tx_hash, timestamp, quantity, proceedsUsd });
      }
    }
  }

  return { events, consumedRowIds, unmatchedCount };
}

export function swapToEvent(s) {
  // Same lowercasing reasoning as transferToEvent — passed through unchanged if null/undefined
  // (whatever a native-ETN leg's actual representation is here, this doesn't change it, only
  // normalizes casing when a real address string is present).
  return {
    kind: "swap",
    txHash: s.tx_hash,
    timestamp: new Date(s.timestamp),
    soldTokenAddress: s.token_sold_address ? s.token_sold_address.toLowerCase() : s.token_sold_address,
    soldQuantity: s.amount_sold,
    soldProceedsUsd: new Decimal(s.amount_sold).times(s.price_usd_sold_leg ?? 0).toString(),
    boughtTokenAddress: s.token_bought_address ? s.token_bought_address.toLowerCase() : s.token_bought_address,
    boughtQuantity: s.amount_bought,
    boughtUnitCostUsd: s.price_usd_bought_leg ?? 0,
  };
}

// ---- DeFi (yield farm / staking) activity -------------------------------------------------
//
// Raw events detected via topic-signature scanning in pnlIngestion.js's ingestDefiActivity — see
// that function's own header comment for why this is topic-based rather than a hardcoded contract
// address list, and defiActivity.js/005_defi_activity.sql's comments for why token identity is
// deliberately NOT stored on those rows. Resolved live here instead, via the exact view functions
// confirmed against the real deployed contracts (Blockscout-verified ABI, fetched and checked by
// hand against https://blockexplorer.electroneum.com/api/v2/smart-contracts/<address> for one
// YieldFarm instance and one CoreAscensionV2 instance before writing this):
//   - YieldFarm template: getFarmById(farmId) -> {token0, token1, name, ...}, rewardToken(),
//     getThirdPartyRewardConfigByFarmId(farmId) -> {token, ...}
//   - CoreAscensionV2 staking template: core() -> the single token that's both staked AND paid out
//     as rewards (confirmed live: this template has no separate reward-token concept at all — it
//     stakes CORE and pays rewards in CORE).
// Every result is cached indefinitely per (contractAddress[, farmId]) — none of this changes for an
// already-deployed farm/stake, same "resolve once, cache indefinitely" pattern as pnlIngestion.js's
// own tokenMetadataCache.
const DEFI_VIEW_IFACE = new ethers.Interface([
  "function getFarmById(uint256 _farmId) view returns (tuple(uint256 id, uint8 version, string name, address poolAddr, uint256 liquidity, uint256 allocPoint, uint256 lastCalcBlock, uint256 accRewardsPerShare, uint256 accThirdPartyRewardsPerShare, address[] farmers, uint256 farmerCount, address token0, address token1, uint256 tokenId, int24 tickLower, int24 tickUpper, uint24 fee, uint256 accFees0PerShare, uint256 accFees1PerShare, bool active))",
  "function rewardToken() view returns (address)",
  "function getThirdPartyRewardConfigByFarmId(uint256 _farmId) view returns (tuple(address token, address tokenManager, uint256 tokensPerBlock, uint256 endBlock))",
  "function core() view returns (address)",
]);
const ERC20_DECIMALS_IFACE = new ethers.Interface(["function decimals() view returns (uint8)"]);

let defiRpcProvider = null;
function getDefiRpcProvider() {
  if (!defiRpcProvider) defiRpcProvider = createRpcProvider({ batchMaxCount: 1 });
  return defiRpcProvider;
}

// Every getter below returns address(es) straight out of a live ethers.Contract call — ethers
// ABI-decodes addresses in their CHECKSUMMED (mixed-case) form, never pre-lowercased. Lowercased
// here, at the source, before caching or returning: transferToEvent's own tokenAddress is always
// lowercased (see its own comment — this exact class of bug already bit that path once, confirmed
// live as the same real token splitting into two separate FIFO/holdings rows over checksum-vs-
// lowercase casing), and every one of these tokens ALSO shows up via regular transfers/swaps
// elsewhere in a member's history — a farm/staking event whose own tokenAddress came back
// checksummed would silently reopen that exact bug for every farm/staking token.
const farmTokensCache = new Map(); // `${contract}:${farmId}` -> { token0, token1, name }
async function getFarmTokens(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (farmTokensCache.has(key)) return farmTokensCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const farm = await contract.getFarmById(farmId);
  const result = { token0: farm.token0.toLowerCase(), token1: farm.token1.toLowerCase(), name: farm.name || null };
  farmTokensCache.set(key, result);
  return result;
}

const rewardTokenCache = new Map(); // contractAddress -> address
async function getFarmRewardToken(contractAddress) {
  const key = contractAddress.toLowerCase();
  if (rewardTokenCache.has(key)) return rewardTokenCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const token = (await contract.rewardToken()).toLowerCase();
  rewardTokenCache.set(key, token);
  return token;
}

const thirdPartyRewardCache = new Map(); // `${contract}:${farmId}` -> address | null
async function getThirdPartyRewardToken(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (thirdPartyRewardCache.has(key)) return thirdPartyRewardCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const config = await contract.getThirdPartyRewardConfigByFarmId(farmId);
  const token = config.token && config.token !== ethers.ZeroAddress ? config.token.toLowerCase() : null;
  thirdPartyRewardCache.set(key, token);
  return token;
}

const stakingTokenCache = new Map(); // contractAddress -> address (also the reward token — see header comment)
async function getStakingToken(contractAddress) {
  const key = contractAddress.toLowerCase();
  if (stakingTokenCache.has(key)) return stakingTokenCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const token = (await contract.core()).toLowerCase();
  stakingTokenCache.set(key, token);
  return token;
}

// Token decimals aren't part of getTokenMetadata's cache (see pnlIngestion.js — that one only ever
// needed name/symbol), and DeFi event amounts are raw uint256s straight off the chain, same as
// pnlIngestion.js's own token-transfer ingestion (see weiToDecimal there) — so this needs its own
// live decimals() read per token, cached indefinitely (an ERC-20's decimals never changes post-
// deploy). Falls back to 18 (the overwhelmingly common case, and what every token seen live in this
// integration — CLUB, DYNO, CORE — actually uses) only if the call itself fails.
const tokenDecimalsCache = new Map();
async function getTokenDecimals(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenDecimalsCache.has(key)) return tokenDecimalsCache.get(key);
  let decimals = 18;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_DECIMALS_IFACE, getDefiRpcProvider());
    decimals = Number(await contract.decimals());
  } catch (err) {
    console.warn(`⚠️  Statement generator: could not read decimals() for ${tokenAddress}, assuming 18:`, err.message);
  }
  tokenDecimalsCache.set(key, decimals);
  return decimals;
}

async function formatTokenAmount(tokenAddress, rawAmount) {
  const decimals = await getTokenDecimals(tokenAddress);
  return ethers.formatUnits(rawAmount, decimals);
}

// Same BOLT token address pnlIngestion.js's enrichFarmRowsWithBolt uses to correlate a farm
// deposit/withdrawal's optional BOLT leg — confirmed live from YieldFarm.sol's own verified
// constructor args on Blockscout, not assumed. See that function's own comment for why the amount
// never appears in the farm's own events and has to be enriched in via a same-tx Transfer log at
// ingestion time instead (raw_args.amountBoltAdded/amountBoltReturned below).
const BOLT_TOKEN_ADDRESS = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";

/** Turns raw defi_activity rows into FIFO events, per the confirmed tax treatment:
 *   - Farm/stake DEPOSIT (including an optional BOLT co-deposit for the rewards multiplier — see
 *     BOLT_TOKEN_ADDRESS above) = a LOT TRANSFER ('lock'), not a disposal — the wallet still
 *     economically owns these tokens, just "location" changes (locked in the farm/stake contract
 *     instead of held directly), same as a self-transfer between the member's own wallets never
 *     being a taxable event. Cost basis carries through unchanged; see fifoLotEngine.js's own
 *     comment on lock()/unlock() for the full reasoning. This DELIBERATELY REVERSES this file's
 *     earlier treatment (a disposal at FMV) — that treatment is what shipped originally, was
 *     confirmed to be the wrong call, and is being corrected here; anyone whose PnL Statement
 *     already included farm/staking activity under the old treatment needs it regenerated.
 *   - Farm/stake WITHDRAWAL of principal (and any returned BOLT) = the reverse ('unlock') — lots
 *     restored to open with their ORIGINAL cost basis, not revalued at withdrawal-day price. The
 *     live price fetched here is used ONLY as unlock()'s fallbackUnitCostUsd, for the rare
 *     shortfall case (ingestion started mid-position, so this ledger never saw the original lock).
 *   - Every reward/fee amount (a farm's own reward token, its third-party reward token, LP fees on
 *     withdrawal, staking rewards) = a FIFO "in" acquisition at ZERO cost basis — UNCHANGED,
 *     confirmed design: rewards are typically non-ETN tokens (DYNO/CORE) and shouldn't register as
 *     income at receipt, only affect Net P&L later if/when actually disposed of (sold, swapped,
 *     sent to a CEX).
 * A row whose contract/farm view-function calls all fail (e.g. a genuinely unknown future contract
 * template reusing one of the five topic signatures by coincidence) is skipped with a warning
 * rather than failing the whole statement — same "never let one enrichment failure take down
 * generation" posture as getBlockByTimestamp/buildPriceCoverageDisclaimer elsewhere in this file.
 * Returns { events, perLabel } — perLabel is the labeled per-farm/per-stake breakdown Map for the
 * PDF section (see buildDefiActivitySummary below), keyed by a human label (the farm's own on-chain
 * name, or the staking template's fixed label) rather than a raw contract address, so nothing in
 * this file ever hardcodes one of the specific addresses the user originally supplied.
 * depositedUsd/withdrawnUsd in that breakdown are still the FMV of what moved at the time — purely
 * informational context for the PDF now that neither one is a realized-PnL event on its own. */
export async function buildDefiFarmEvents(defiActivity, priorityAssets = null) {
  const events = [];
  const perLabel = new Map(); // label -> { depositedUsd, withdrawnUsd, rewardsUsd (Decimal), unpriced count }
  const bumpLabel = (label) => {
    if (!perLabel.has(label)) perLabel.set(label, { depositedUsd: new Decimal(0), withdrawnUsd: new Decimal(0), rewardsUsd: new Decimal(0), unpriced: 0 });
    return perLabel.get(label);
  };
  // Same priorityAssets scoping as pnlIngestion.js's priceOrNull — a non-priority token here still
  // gets priced for free if already cached, and never triggers a fresh bulk backfill on the
  // critical path. generateStatement never passes priorityAssets, so a Statement's DeFi pricing is
  // always full and complete, unaffected by this.
  const priceAt = (tokenAddress, timestamp) =>
    priorityAssets && !priorityAssets.has(tokenAddress.toLowerCase())
      ? getCachedHistoricalPriceUsd(tokenAddress, timestamp)
      : getHistoricalPriceUsd(tokenAddress, timestamp).catch(() => null);

  for (const row of defiActivity) {
    const timestamp = new Date(row.timestamp);
    const raw = row.raw_args || {};
    const txHash = row.tx_hash;
    try {
      if (row.event_type === "farm_deposit") {
        const { token0, token1, name } = await getFarmTokens(row.contract_address, row.farm_id);
        const agg = bumpLabel(name || `Yield Farm #${row.farm_id}`);
        const legs = [[token0, raw.amount0Added], [token1, raw.amount1Added]];
        if (raw.amountBoltAdded && BigInt(raw.amountBoltAdded) > 0n) legs.push([BOLT_TOKEN_ADDRESS, raw.amountBoltAdded]);
        for (const [tokenAddress, rawAmount] of legs) {
          if (!tokenAddress || tokenAddress === ethers.ZeroAddress || !rawAmount || BigInt(rawAmount) === 0n) continue;
          const quantity = await formatTokenAmount(tokenAddress, rawAmount);
          // FMV here is informational only now (the PDF's own "deposited" figure) — lock() itself
          // needs no price at all, cost basis carries through from whatever lot(s) it consumes.
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.depositedUsd = agg.depositedUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
          events.push({ kind: "lock", tokenAddress, txHash, timestamp, quantity });
        }
      } else if (row.event_type === "farm_withdraw") {
        const { token0, token1, name } = await getFarmTokens(row.contract_address, row.farm_id);
        const agg = bumpLabel(name || `Yield Farm #${row.farm_id}`);
        const legs = [[token0, raw.amount0Withdrawn], [token1, raw.amount1Withdrawn]];
        if (raw.amountBoltReturned && BigInt(raw.amountBoltReturned) > 0n) legs.push([BOLT_TOKEN_ADDRESS, raw.amountBoltReturned]);
        for (const [tokenAddress, rawAmount] of legs) {
          if (!tokenAddress || tokenAddress === ethers.ZeroAddress || !rawAmount || BigInt(rawAmount) === 0n) continue;
          const quantity = await formatTokenAmount(tokenAddress, rawAmount);
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.withdrawnUsd = agg.withdrawnUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
          // fallbackUnitCostUsd only ever applies to an unlock SHORTFALL (see fifoLotEngine.js's
          // own comment) — the common case restores each lot's real original cost basis untouched,
          // this live price is never used for it.
          events.push({ kind: "unlock", tokenAddress, txHash, timestamp, quantity, fallbackUnitCostUsd: priceUsd ?? 0 });
        }
        // Farm's own reward token, LP fees (fees0/fees1 — the same tokens as token0/token1, but
        // acquired at zero cost basis, so tracked as separate "in" events rather than folded into
        // the principal reacquisition above), and the third-party reward token — all zero-cost-
        // basis acquisitions (see this function's header comment).
        const rewardLegs = [];
        if (raw.amountRewards && BigInt(raw.amountRewards) > 0n) {
          const rewardToken = await getFarmRewardToken(row.contract_address).catch(() => null);
          if (rewardToken) rewardLegs.push([rewardToken, raw.amountRewards]);
        }
        if (raw.fees0Collected && BigInt(raw.fees0Collected) > 0n && token0) rewardLegs.push([token0, raw.fees0Collected]);
        if (raw.fees1Collected && BigInt(raw.fees1Collected) > 0n && token1) rewardLegs.push([token1, raw.fees1Collected]);
        if (raw.thirdPartyRewardsCollected && BigInt(raw.thirdPartyRewardsCollected) > 0n) {
          const tpToken = await getThirdPartyRewardToken(row.contract_address, row.farm_id).catch(() => null);
          if (tpToken) rewardLegs.push([tpToken, raw.thirdPartyRewardsCollected]);
        }
        for (const [tokenAddress, rawAmount] of rewardLegs) {
          const quantity = await formatTokenAmount(tokenAddress, rawAmount);
          events.push({ kind: "in", tokenAddress, txHash, timestamp, quantity, unitCostUsd: 0 });
          // The labeled breakdown still shows rewards at their real FMV (informational) even
          // though the FIFO math above records them at $0 cost basis — otherwise the PDF's
          // "Rewards Earned" figure would misleadingly read as $0 for a farm that's actually paying out.
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.rewardsUsd = agg.rewardsUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
        }
      } else if (row.event_type === "core_staked") {
        const tokenAddress = await getStakingToken(row.contract_address);
        const agg = bumpLabel("Core Ascension Staking");
        if (raw.amount && BigInt(raw.amount) > 0n) {
          const quantity = await formatTokenAmount(tokenAddress, raw.amount);
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.depositedUsd = agg.depositedUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
          events.push({ kind: "lock", tokenAddress, txHash, timestamp, quantity });
        }
      } else if (row.event_type === "core_withdrawn") {
        const tokenAddress = await getStakingToken(row.contract_address);
        const agg = bumpLabel("Core Ascension Staking");
        // CoreWithdrawn distinguishes requestedAmount from returnedAmount — an early-withdrawal
        // penalty (penaltyToPool/penaltyBurned) can slash part of the position, and that forfeited
        // slice is GONE, not still-locked: unlocking only returnedAmount (what the older, disposal-
        // based treatment effectively did — see this function's own header comment) would leave it
        // orphaned in the locked queue forever instead of recording the real, permanent loss it is.
        // So the FULL requestedAmount is unlocked first (restoring every bit of its original cost
        // basis to open lots), then the forfeited slice, if any, is disposed of at $0 proceeds —
        // same "genuinely gone, not fake-realized-later" honesty as any other zero-proceeds loss.
        const requested = BigInt(raw.requestedAmount || raw.returnedAmount || 0);
        const returned = BigInt(raw.returnedAmount || 0);
        const forfeited = requested > returned ? requested - returned : 0n;
        const priceUsd = requested > 0n ? await priceAt(tokenAddress, timestamp) : null;
        // withdrawnUsd (the PDF's own "how much came back to you" figure) reflects only what was
        // actually RETURNED — the forfeited slice never came back, so it must not inflate this.
        if (returned > 0n) {
          if (priceUsd != null) agg.withdrawnUsd = agg.withdrawnUsd.plus(new Decimal(await formatTokenAmount(tokenAddress, returned)).times(priceUsd));
          else agg.unpriced++;
        }
        if (requested > 0n) {
          const quantity = await formatTokenAmount(tokenAddress, requested);
          events.push({ kind: "unlock", tokenAddress, txHash, timestamp, quantity, fallbackUnitCostUsd: priceUsd ?? 0 });
        }
        if (forfeited > 0n) {
          const quantity = await formatTokenAmount(tokenAddress, forfeited);
          events.push({ kind: "out", tokenAddress, txHash, timestamp, quantity, proceedsUsd: 0 });
        }
      } else if (row.event_type === "reward_paid") {
        const tokenAddress = await getStakingToken(row.contract_address);
        const agg = bumpLabel("Core Ascension Staking");
        // Confirmed live via a real RewardPaid event where paidAmount === slashedAmount (the
        // entire reward clawed back by an early-withdrawal penalty): the actual net amount
        // received is paidAmount - slashedAmount, never paidAmount alone.
        const paid = BigInt(raw.paidAmount || 0);
        const slashed = BigInt(raw.slashedAmount || 0);
        const net = paid > slashed ? paid - slashed : 0n;
        if (net > 0n) {
          const quantity = await formatTokenAmount(tokenAddress, net);
          events.push({ kind: "in", tokenAddress, txHash, timestamp, quantity, unitCostUsd: 0 });
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.rewardsUsd = agg.rewardsUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
        }
      }
    } catch (err) {
      console.warn(`⚠️  Statement generator: could not resolve DeFi event ${row.event_type} for tx ${txHash} (contract ${row.contract_address}):`, err.message);
    }
  }

  return { events, perLabel };
}

export async function computeGasFeesUsd(transfersInPeriod) {
  const gasRows = transfersInPeriod.filter((t) => t.gas_fee_wei != null);
  let totalGasWei = 0n;
  let totalGasUsd = new Decimal(0);
  for (const row of gasRows) {
    totalGasWei += BigInt(row.gas_fee_wei);
    try {
      const priceUsd = await getHistoricalPriceUsd(NATIVE_SENTINEL, new Date(row.timestamp));
      totalGasUsd = totalGasUsd.plus(new Decimal(ethers.formatEther(row.gas_fee_wei)).times(priceUsd));
    } catch (err) {
      console.warn(`⚠️  Statement generator: could not price gas fee for tx ${row.tx_hash}:`, err.message);
    }
  }
  return { totalGasEtn: ethers.formatEther(totalGasWei), totalGasUsd };
}

/** Values a set of lots (opening or closing inventory) at a given point in time — quantity, cost
 * basis, and market value per token, plus (for closing inventory specifically) the unrealized P&L
 * that comparing market value against cost basis gives. Shared by both Opening and Closing
 * Inventory: opening only ever uses quantity/marketValueUsd (there's no "opening unrealized P&L"
 * concept), closing uses everything including totalUnrealizedUsd for the Summary section.
 * totalUnrealizedUsd only ever includes a token if ITS OWN price resolved — a token with an
 * unresolved price contributes to neither side of that delta, rather than only being subtracted as
 * cost basis with no offsetting market value (which would wrongly read as a full loss on that
 * token instead of "unknown"). */
export async function valueInventoryAtTimestamp(lots, timestamp) {
  const byToken = new Map();
  for (const lot of lots) {
    if (!byToken.has(lot.tokenAddress)) byToken.set(lot.tokenAddress, []);
    byToken.get(lot.tokenAddress).push(lot);
  }

  let totalMarketValueUsd = new Decimal(0);
  let totalUnrealizedUsd = new Decimal(0);
  const perToken = [];
  for (const [tokenAddress, tokenLots] of byToken) {
    const quantity = tokenLots.reduce((sum, l) => sum.plus(l.quantityRemaining), new Decimal(0));
    const costBasis = tokenLots.reduce((sum, l) => sum.plus(l.quantityRemaining.times(l.unitCostUsd)), new Decimal(0));
    let marketValue = null;
    try {
      const priceUsd = await getHistoricalPriceUsd(tokenAddress, timestamp);
      marketValue = quantity.times(priceUsd);
      totalMarketValueUsd = totalMarketValueUsd.plus(marketValue);
      totalUnrealizedUsd = totalUnrealizedUsd.plus(marketValue.minus(costBasis));
    } catch (err) {
      console.warn(`⚠️  Statement generator: could not price ${tokenAddress} at ${timestamp.toISOString()}:`, err.message);
    }
    perToken.push({ tokenAddress, quantity: quantity.toString(), costBasisUsd: costBasis.toString(), marketValueUsd: marketValue?.toString() ?? null });
  }
  return { totalMarketValueUsd, totalUnrealizedUsd, perToken };
}

/** Combines every NFT tokenId's own row in a `perToken`-shaped array (see
 * valueInventoryAtTimestamp) into ONE row per collection — a wallet's live holdings list is a
 * per-asset money view, not an item-by-item inventory, so surfacing this app's own per-lot
 * `nftAssetKey` detail ("collectionAddress:tokenId") there is internal bookkeeping leaking into a
 * summary that has nowhere sane to show it (no NFT price feed exists to give any one tokenId its
 * own $ figure anyway — see marketValueUsd's own comment above). Detects an NFT row purely by key
 * shape (`isNftAssetKey`-style — contains ":"), same convention as pnlStatementGenerator.js's own
 * isNftAssetKey/formatAssetLabel for the PDF Statement, just not sharing that function directly
 * since this returns a different shape (more rows to merge, not one formatted label).
 *
 * `excludeCollectionAddresses` (lowercased) lets a caller opt specific "address:id"-shaped keys out
 * of this grouping entirely — needed because this app also tracks V3 concentrated-liquidity
 * positions under the EXACT same key shape (see pnlIngestion.js's own V3 header comment), and a
 * position isn't a collectible a member wants combined away; passing the V3 position manager's own
 * address here leaves those rows passed through untouched, one per position, same as any regular
 * fungible-token row.
 *
 * The combined row's quantity is the sum of every tokenId's own quantity (not a count of distinct
 * tokenIds — an ERC-1155 lot can hold more than one copy of the same tokenId), its costBasisUsd is
 * the sum across every tokenId, and its marketValueUsd follows the same "omit rather than
 * fabricate" rule as everywhere else in this file: null unless every single tokenId's own price
 * resolved (in practice this always stays null today, since no NFT price feed exists — this
 * doesn't hardcode that assumption, so it degrades correctly if one ever does). */
export function groupNftHoldingsByCollection(perToken, excludeCollectionAddresses = new Set()) {
  const grouped = new Map(); // collection address (lowercase) -> { tokenAddress, quantity, costBasisUsd, marketValueUsd }
  const rows = [];
  for (const row of perToken) {
    const key = row.tokenAddress;
    const colonIndex = typeof key === "string" ? key.indexOf(":") : -1;
    if (colonIndex === -1 || excludeCollectionAddresses.has(key.slice(0, colonIndex))) {
      rows.push(row);
      continue;
    }
    const collectionAddress = key.slice(0, colonIndex);
    const quantity = new Decimal(row.quantity);
    const costBasisUsd = new Decimal(row.costBasisUsd);
    const marketValueUsd = row.marketValueUsd != null ? new Decimal(row.marketValueUsd) : null;
    const existing = grouped.get(collectionAddress);
    if (!existing) {
      grouped.set(collectionAddress, { tokenAddress: collectionAddress, quantity, costBasisUsd, marketValueUsd });
    } else {
      existing.quantity = existing.quantity.plus(quantity);
      existing.costBasisUsd = existing.costBasisUsd.plus(costBasisUsd);
      existing.marketValueUsd = existing.marketValueUsd != null && marketValueUsd != null ? existing.marketValueUsd.plus(marketValueUsd) : null;
    }
  }
  for (const g of grouped.values()) {
    rows.push({ tokenAddress: g.tokenAddress, quantity: g.quantity.toString(), costBasisUsd: g.costBasisUsd.toString(), marketValueUsd: g.marketValueUsd?.toString() ?? null });
  }
  return rows;
}

/** Same collection-grouping as groupNftHoldingsByCollection, for the `[{ tokenAddress,
 * realizedPnlUsd }]` shape realizedByToken uses instead — a separate function rather than one
 * trying to handle both row shapes, since summing "realizedPnlUsd" and summing "costBasisUsd" +
 * combining "marketValueUsd" are different enough operations that sharing one function would need
 * more branching than just having two. Both must group NFT tokenIds the same way and stay in sync —
 * a dashboard token filter built from one and applied to the other (see pnlSnapshotService.js's own
 * computeLivePnlSnapshot) needs matching keys on both sides, or a selected collection's realized P&L
 * silently reads as zero instead of what it actually is. */
export function groupNftRealizedByCollection(realizedByToken, excludeCollectionAddresses = new Set()) {
  const grouped = new Map(); // collection address (lowercase) -> Decimal
  const rows = [];
  for (const row of realizedByToken) {
    const key = row.tokenAddress;
    const colonIndex = typeof key === "string" ? key.indexOf(":") : -1;
    if (colonIndex === -1 || excludeCollectionAddresses.has(key.slice(0, colonIndex))) {
      rows.push(row);
      continue;
    }
    const collectionAddress = key.slice(0, colonIndex);
    const running = grouped.get(collectionAddress) || new Decimal(0);
    grouped.set(collectionAddress, running.plus(new Decimal(row.realizedPnlUsd)));
  }
  for (const [tokenAddress, realizedPnlUsd] of grouped) {
    rows.push({ tokenAddress, realizedPnlUsd: realizedPnlUsd.toString() });
  }
  return rows;
}
