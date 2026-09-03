// backend/services/pnlStatementGenerator.js
//
// Assembles one PnL statement: triggers ingestion, replays FIFO cost-basis over the wallet's full
// history up to this period's end (see fifoLotEngine.js's replayFifo and the migration's own note
// on why this is an in-memory replay rather than a live-mutated ledger table), computes fees/
// realized/unrealized PnL, and freezes the result as a JSON + PDF artifact in R2. Once written,
// GENERATED status means these two files are the permanent, immutable record — see
// statementRequests.markGenerated and the build brief's "statement freeze" requirement: a later
// price correction is a new, separately-labeled re-issue, never a mutation of this output.
import PDFDocument from "pdfkit";
import { ethers } from "ethers";
import Decimal from "decimal.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import { fileURLToPath } from "url";
import { getById, markGenerated } from "../db/statementRequests.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { ingestWalletHistory, getBlockByTimestamp, getTokenMetadata, resolveEnsDisplayName, EXPLORER_BASE_URL } from "./pnlIngestion.js";
import { replayFifo } from "./fifoLotEngine.js";
import { getHistoricalPriceUsd, getEarliestAvailableDate } from "./pnlPricing.js";
import { computePeriodBoundaries, periodTypeLabel } from "./periodTypes.js";
import { listCexAddresses } from "../db/cexAddresses.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Planet Zephyros brand palette — kept in exact sync with src/dashboard/theme.js by hand (this
// backend has no build step that could import that frontend file directly). If the dashboard's
// palette ever changes, update both.
const THEME = {
  background: "#081c0a",
  green: "#18bb1a",
  orange: "#ff8a3d", // theme.js's warning/attention color — used for the price-coverage disclaimer
  white: "#ffffff",
  bodyText: "#e5e5e5", // slightly softer than pure white for dense paragraph/detail text
  muted: "#9a9a9a", // theme.js's mutedLight
  border: "#333333",
};
const LOGO_PATH = path.resolve(__dirname, "..", "assets", "PlanetZephyrosLogo.png");
const WORDMARK_PATH = path.resolve(__dirname, "..", "assets", "PlanetZephyrosText.png");
const ORBITRON_BOLD_PATH = path.resolve(__dirname, "..", "fonts", "Orbitron-Bold.ttf");
// /pnl is the feature's canonical path on the existing dashboard.planetzephyros.xyz domain (see
// DashboardApp.jsx's tab-init logic) — no separate subdomain/DNS entry needed. This constant only
// affects newly-generated statements going forward; already-frozen PDFs keep whatever link they
// were built with.
const PREMIUM_TAB_URL = "https://dashboard.planetzephyros.xyz/pnl";

const NATIVE_SENTINEL = "NATIVE";
const DISCLAIMER =
  "This statement is provided for informational purposes only and does not constitute tax, " +
  "legal, or financial advice. Figures use FIFO cost-basis accounting over a fixed reporting " +
  "period, which may not match every jurisdiction's actual tax treatment. Consult a qualified " +
  "professional in your jurisdiction before relying on this statement for tax filing.";

// Plain-English explanations for the Summary section's line items, shown further down the
// statement (after Closing Inventory) rather than inline — keeps the Summary itself scannable
// while still giving every figure a real definition somewhere in the document.
const SUMMARY_EXPLANATIONS = [
  ["On-chain inflows / outflows (USD)", "The USD value of ETN and tokens received or sent on-chain during this period, including both legs of any swap (the sold side counts as an outflow, the bought side as an inflow) — excluding transfers between your own addresses (see \"self-owned addresses\") and gas fees, which are broken out separately below."],
  ["CEX deposits / withdrawals (USD)", "The USD value of transfers to/from addresses recognized as centralized exchange wallets. Only wallets this app already has on record are detected automatically — anything missed shows up as an on-chain flow instead."],
  ["Gas fees paid", "The total transaction fees this wallet paid across every transaction in the period, valued in ETN and in USD at the time each fee was paid. Deducted from Net P&L, but not treated as a disposal for cost-basis purposes."],
  ["Realized P&L (USD)", "Profit or loss actually locked in during this period: for every disposal (a sale, swap, or outbound transfer that isn't a self-transfer), proceeds minus the FIFO cost basis of the specific lot(s) consumed. FIFO means the oldest acquired units of an asset are always treated as sold first."],
  ["Unrealized P&L (USD)", "The paper profit or loss on whatever this wallet still held at the exact end of the period: current market value at the period-end date minus the FIFO cost basis of those remaining holdings. Nothing here has actually been sold — it reflects value on paper only, as of the period-end snapshot."],
  ["Net P&L after fees (USD)", "Realized P&L plus Unrealized P&L, minus total gas fees paid (USD) for the period. The single bottom-line figure for the period."],
];

let cachedR2Client = null;
function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return cachedR2Client;
}

async function uploadStatementArtifact(body, key, contentType) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured — cannot store statement artifact");
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Genuinely immutable once written — see this file's header comment.
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

/** True addresses never contain ":" — buildNftEvents's own lot-key convention for one specific
 * NFT is "collectionAddress:tokenId". Used wherever a value that's usually a bare token address
 * needs to be told apart from that composite form. */
function isNftAssetKey(assetKey) {
  return assetKey.includes(":");
}

/** "Name (SYMBOL) (0xAddress)" for a fungible token, "CollectionName #id (0xAddress)" for one
 * specific NFT (assetKey "collectionAddress:tokenId" — see buildNftEvents), degrading gracefully
 * to just the address/id if metadata lookup failed. Native ETN has no contract address, so it
 * never gets a trailing "(0x...)" segment. `tokenMeta` is the Map built by collectTokenMetadata,
 * keyed by bare collection/token address either way (never the composite NFT key). */
function formatAssetLabel(assetKey, tokenMeta) {
  if (assetKey === NATIVE_SENTINEL) return "Electroneum (ETN)";
  if (isNftAssetKey(assetKey)) {
    const [collectionAddress, tokenId] = assetKey.split(":");
    const meta = tokenMeta.get(collectionAddress.toLowerCase());
    const collectionLabel = meta?.name || meta?.symbol || collectionAddress;
    return `${collectionLabel} #${tokenId} (${collectionAddress})`;
  }
  const meta = tokenMeta.get(assetKey.toLowerCase());
  if (meta?.name && meta?.symbol) return `${meta.name} (${meta.symbol}) (${assetKey})`;
  if (meta?.symbol) return `${meta.symbol} (${assetKey})`;
  return assetKey;
}

/** Resolves and caches name/symbol for every distinct token/NFT-collection address appearing
 * anywhere in this statement (opening/closing inventory, unrealized holdings, realized disposal
 * events, plus every in-period transfer/swap for the Transaction History section) in one pass, so
 * formatAssetLabel/JSON enrichment never has to do it ad hoc per line item. Native ETN is never
 * looked up (formatAssetLabel special-cases it directly); NFT composite keys are reduced to their
 * bare collection address first, since that's the actual contract Blockscout's metadata endpoint
 * knows about — a specific tokenId is never itself a lookup target. */
async function collectTokenMetadata(openingLots, closingLots, unrealizedPerToken, realizedEvents, transfersInPeriod, swapsInPeriod) {
  const addresses = new Set();
  const addBare = (key) => { if (key && key !== NATIVE_SENTINEL) addresses.add((isNftAssetKey(key) ? key.split(":")[0] : key).toLowerCase()); };
  for (const l of openingLots) addBare(l.tokenAddress);
  for (const l of closingLots) addBare(l.tokenAddress);
  for (const t of unrealizedPerToken) addBare(t.tokenAddress);
  for (const e of realizedEvents) addBare(e.tokenAddress);
  for (const t of transfersInPeriod) addBare(t.token_address);
  for (const s of swapsInPeriod) {
    addBare(s.token_sold_address);
    addBare(s.token_bought_address);
  }

  const tokenMeta = new Map();
  await Promise.all(
    [...addresses].map(async (addr) => {
      const meta = await getTokenMetadata(addr);
      if (meta) tokenMeta.set(addr, meta);
    })
  );
  return { tokenMeta, addresses };
}

/** Compares periodStart against every relevant asset's actual earliest-available price data (per
 * price_history_backfill_state — real discovered boundaries, not a guessed date) and returns a
 * disclaimer string if the period predates full coverage for any of them, or null if the whole
 * period is covered. Free-tier price sources (GeckoTerminal, CoinGecko) both impose a rolling
 * historical window rather than exposing full history — confirmed live: ~184 days for
 * GeckoTerminal regardless of a pool's actual age, ~365 days for CoinGecko (native ETN only, no
 * equivalent fallback exists for arbitrary tokens) — so any statement reaching far enough back WILL
 * have incomplete pricing for its earliest portion, and that's expected, not a bug to chase. */
async function buildPriceCoverageDisclaimer(periodStart, tokenAddresses) {
  const assets = ["NATIVE", ...tokenAddresses];
  let latestBoundary = null; // the latest (most restrictive) earliest-available-date across all relevant assets
  for (const asset of assets) {
    const earliest = await getEarliestAvailableDate(asset);
    if (earliest && (!latestBoundary || earliest > latestBoundary)) latestBoundary = earliest;
  }
  if (!latestBoundary || periodStart >= latestBoundary) return null;
  return (
    `Price data for this period is incomplete before ${latestBoundary.toISOString().slice(0, 10)} — free-tier price ` +
    `sources only expose a rolling recent window (not a fixed calendar date), so cost-basis/proceeds for ` +
    `transactions earlier than that show as unavailable rather than an estimated or incorrect figure.`
  );
}

function transferToEvent(t) {
  const tokenAddress = t.token_address || NATIVE_SENTINEL;
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

// Known Core Clash game contracts on Electroneum mainnet — confirmed live via Blockscout
// (verified source, real interaction history against the wallet used to build/test this feature).
// Wagers/winnings move as plain ERC-20/native transfers to/from these addresses, already captured
// by the generic ingestion pipeline — this section is a labeled BREAKDOWN of amounts already
// counted in Realized P&L above, not a separate/additive figure (see buildGameActivitySummary's
// own comment). CLUBSpinVault is a one-way prize payout (no wager side at all, confirmed via its
// own contract — no "cost to play" leg exists to net against), included as a "won" line only.
const KNOWN_GAME_CONTRACTS = new Map([
  ["0xbb9ec09eab6d680e2a6c4794c34a9b3c0208fce2", "CoreClashTradingCardGame"],
  ["0x113129f0865058a840d7ad78a655735a590c7c03", "CoreClashGame"],
  ["0x9043c8797b3a3babd877aeed3e3cc3baad2d53c2", "CLUBSpinVault"],
]);

/** Breaks out wagered vs. won amounts specifically against known Core Clash game contracts, from
 * transfers already collected by the generic ingestion pipeline — NOT a separate calculation, and
 * NOT additive to Net P&L (these amounts are already counted there as ordinary disposals/
 * acquisitions of whatever token was wagered). Purely a labeled re-view for visibility, per the
 * explicit "if it cost me 50 CORE to play and I won 100 CORE, I need to see this" request. */
function buildGameActivitySummary(transfersInPeriod) {
  const perGame = new Map(); // contract address -> { name, wageredUsd, wonUsd, wageredUnpriced, wonUnpriced }
  for (const t of transfersInPeriod) {
    const name = KNOWN_GAME_CONTRACTS.get(t.counterparty_address?.toLowerCase());
    if (!name || Number(t.amount_raw) === 0 || t.gas_fee_wei != null) continue;
    if (!perGame.has(name)) perGame.set(name, { wageredUsd: new Decimal(0), wonUsd: new Decimal(0), wageredUnpriced: 0, wonUnpriced: 0 });
    const g = perGame.get(name);
    if (t.direction === "out") {
      if (t.usd_value != null) g.wageredUsd = g.wageredUsd.plus(t.usd_value);
      else g.wageredUnpriced++;
    } else {
      if (t.usd_value != null) g.wonUsd = g.wonUsd.plus(t.usd_value);
      else g.wonUnpriced++;
    }
  }
  return perGame;
}

const NFT_ASSET_TYPES = new Set(["erc721", "erc1155"]);

/** "collectionAddress:tokenId" — the lot key one specific NFT is tracked under everywhere in this
 * file (FIFO lots, formatAssetLabel, collectTokenMetadata). Distinct from a fungible token's plain
 * address specifically so fifoLotEngine.js — which has no NFT-specific code at all, it just keys
 * lots by whatever string it's given — never pools two different NFTs (or an NFT and a same-
 * collection fungible token, if that were ever possible) into one FIFO queue. */
function nftAssetKey(t) {
  return `${t.token_address}:${t.token_id}`;
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
function buildNftEvents(transfers) {
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

function swapToEvent(s) {
  return {
    kind: "swap",
    txHash: s.tx_hash,
    timestamp: new Date(s.timestamp),
    soldTokenAddress: s.token_sold_address,
    soldQuantity: s.amount_sold,
    soldProceedsUsd: new Decimal(s.amount_sold).times(s.price_usd_sold_leg ?? 0).toString(),
    boughtTokenAddress: s.token_bought_address,
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

const farmTokensCache = new Map(); // `${contract}:${farmId}` -> { token0, token1, name }
async function getFarmTokens(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (farmTokensCache.has(key)) return farmTokensCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const farm = await contract.getFarmById(farmId);
  const result = { token0: farm.token0, token1: farm.token1, name: farm.name || null };
  farmTokensCache.set(key, result);
  return result;
}

const rewardTokenCache = new Map(); // contractAddress -> address
async function getFarmRewardToken(contractAddress) {
  const key = contractAddress.toLowerCase();
  if (rewardTokenCache.has(key)) return rewardTokenCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const token = await contract.rewardToken();
  rewardTokenCache.set(key, token);
  return token;
}

const thirdPartyRewardCache = new Map(); // `${contract}:${farmId}` -> address | null
async function getThirdPartyRewardToken(contractAddress, farmId) {
  const key = `${contractAddress.toLowerCase()}:${farmId}`;
  if (thirdPartyRewardCache.has(key)) return thirdPartyRewardCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const config = await contract.getThirdPartyRewardConfigByFarmId(farmId);
  const token = config.token && config.token !== ethers.ZeroAddress ? config.token : null;
  thirdPartyRewardCache.set(key, token);
  return token;
}

const stakingTokenCache = new Map(); // contractAddress -> address (also the reward token — see header comment)
async function getStakingToken(contractAddress) {
  const key = contractAddress.toLowerCase();
  if (stakingTokenCache.has(key)) return stakingTokenCache.get(key);
  const contract = new ethers.Contract(contractAddress, DEFI_VIEW_IFACE, getDefiRpcProvider());
  const token = await contract.core();
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

/** Turns raw defi_activity rows into FIFO events, per the confirmed tax treatment:
 *   - Farm/stake DEPOSIT = a disposal (FIFO "out") of the deposited token(s) at their own FMV —
 *     the same "proceeds = FMV of what's given up" treatment swapToEvent already uses for a swap's
 *     sold leg, since a farm/staking position isn't itself a priceable, fungible asset to record as
 *     the "proceeds" received in exchange.
 *   - Farm/stake WITHDRAWAL of principal = a reacquisition (FIFO "in") of the returned token(s), at
 *     their own FMV cost basis.
 *   - Every reward/fee amount (a farm's own reward token, its third-party reward token, LP fees on
 *     withdrawal, staking rewards) = a FIFO "in" acquisition at ZERO cost basis — confirmed design:
 *     rewards are typically non-ETN tokens (DYNO/CORE) and shouldn't register as income at receipt,
 *     only affect Net P&L later if/when actually disposed of (sold, swapped, sent to a CEX).
 * A row whose contract/farm view-function calls all fail (e.g. a genuinely unknown future contract
 * template reusing one of the five topic signatures by coincidence) is skipped with a warning
 * rather than failing the whole statement — same "never let one enrichment failure take down
 * generation" posture as getBlockByTimestamp/buildPriceCoverageDisclaimer elsewhere in this file.
 * Returns { events, perLabel } — perLabel is the labeled per-farm/per-stake breakdown Map for the
 * new PDF section (see buildDefiActivitySummary below), keyed by a human label (the farm's own
 * on-chain name, or the staking template's fixed label) rather than a raw contract address, so nothing
 * in this file ever hardcodes one of the specific addresses the user originally supplied. */
async function buildDefiFarmEvents(defiActivity) {
  const events = [];
  const perLabel = new Map(); // label -> { depositedUsd, withdrawnUsd, rewardsUsd (Decimal), unpriced count }
  const bumpLabel = (label) => {
    if (!perLabel.has(label)) perLabel.set(label, { depositedUsd: new Decimal(0), withdrawnUsd: new Decimal(0), rewardsUsd: new Decimal(0), unpriced: 0 });
    return perLabel.get(label);
  };
  const priceAt = (tokenAddress, timestamp) => getHistoricalPriceUsd(tokenAddress, timestamp).catch(() => null);

  for (const row of defiActivity) {
    const timestamp = new Date(row.timestamp);
    const raw = row.raw_args || {};
    const txHash = row.tx_hash;
    try {
      if (row.event_type === "farm_deposit") {
        const { token0, token1, name } = await getFarmTokens(row.contract_address, row.farm_id);
        const agg = bumpLabel(name || `Yield Farm #${row.farm_id}`);
        for (const [tokenAddress, rawAmount] of [[token0, raw.amount0Added], [token1, raw.amount1Added]]) {
          if (!tokenAddress || tokenAddress === ethers.ZeroAddress || !rawAmount || BigInt(rawAmount) === 0n) continue;
          const quantity = await formatTokenAmount(tokenAddress, rawAmount);
          const priceUsd = await priceAt(tokenAddress, timestamp);
          const proceedsUsd = priceUsd != null ? new Decimal(quantity).times(priceUsd).toString() : 0;
          if (priceUsd != null) agg.depositedUsd = agg.depositedUsd.plus(proceedsUsd); else agg.unpriced++;
          events.push({ kind: "out", tokenAddress, txHash, timestamp, quantity, proceedsUsd });
        }
      } else if (row.event_type === "farm_withdraw") {
        const { token0, token1, name } = await getFarmTokens(row.contract_address, row.farm_id);
        const agg = bumpLabel(name || `Yield Farm #${row.farm_id}`);
        for (const [tokenAddress, rawAmount] of [[token0, raw.amount0Withdrawn], [token1, raw.amount1Withdrawn]]) {
          if (!tokenAddress || tokenAddress === ethers.ZeroAddress || !rawAmount || BigInt(rawAmount) === 0n) continue;
          const quantity = await formatTokenAmount(tokenAddress, rawAmount);
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.withdrawnUsd = agg.withdrawnUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
          events.push({ kind: "in", tokenAddress, txHash, timestamp, quantity, unitCostUsd: priceUsd ?? 0 });
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
          const proceedsUsd = priceUsd != null ? new Decimal(quantity).times(priceUsd).toString() : 0;
          if (priceUsd != null) agg.depositedUsd = agg.depositedUsd.plus(proceedsUsd); else agg.unpriced++;
          events.push({ kind: "out", tokenAddress, txHash, timestamp, quantity, proceedsUsd });
        }
      } else if (row.event_type === "core_withdrawn") {
        const tokenAddress = await getStakingToken(row.contract_address);
        const agg = bumpLabel("Core Ascension Staking");
        if (raw.returnedAmount && BigInt(raw.returnedAmount) > 0n) {
          const quantity = await formatTokenAmount(tokenAddress, raw.returnedAmount);
          const priceUsd = await priceAt(tokenAddress, timestamp);
          if (priceUsd != null) agg.withdrawnUsd = agg.withdrawnUsd.plus(new Decimal(quantity).times(priceUsd)); else agg.unpriced++;
          events.push({ kind: "in", tokenAddress, txHash, timestamp, quantity, unitCostUsd: priceUsd ?? 0 });
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

async function computeGasFeesUsd(transfersInPeriod) {
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

function summarizeFlows(transfersInPeriod, swapsInPeriod, cexAddressSet) {
  // Categorized purely for the statement's readable line items — the FIFO math itself doesn't
  // care about these categories, only about in/out/self/swap (see transferToEvent above).
  const summary = { onChainIn: new Decimal(0), onChainOut: new Decimal(0), cexIn: new Decimal(0), cexOut: new Decimal(0) };
  for (const t of transfersInPeriod) {
    if (t.gas_fee_wei != null || Number(t.amount_raw) === 0 || t.is_self_transfer) continue;
    const usd = new Decimal(t.usd_value ?? 0);
    // cexAddressSet, not the row's own stored is_cex — see buildTransactionLines' identical comment
    // below for why: is_cex is baked in at ingestion time, and ingestion is incremental, so a CEX
    // address added *after* a wallet's history was already ingested would never retroactively
    // apply without this.
    if (cexAddressSet.has(String(t.counterparty_address).toLowerCase())) {
      if (t.direction === "in") summary.cexIn = summary.cexIn.plus(usd);
      else summary.cexOut = summary.cexOut.plus(usd);
    } else {
      if (t.direction === "in") summary.onChainIn = summary.onChainIn.plus(usd);
      else summary.onChainOut = summary.onChainOut.plus(usd);
    }
  }
  // Swaps are always on-chain DEX trades, never CEX and never a self-transfer by definition — the
  // sold leg counts as an outflow, the bought leg as an inflow, same as any other on-chain
  // transfer. Confirmed deliberate addition (previously swap legs were only reflected in Realized
  // Gains & Losses, not in this flow summary at all) — folds swaps into the same "everything that
  // moved on-chain" total Transaction History already shows them as part of.
  for (const s of swapsInPeriod ?? []) {
    summary.onChainOut = summary.onChainOut.plus(new Decimal(s.amount_sold).times(s.price_usd_sold_leg ?? 0));
    summary.onChainIn = summary.onChainIn.plus(new Decimal(s.amount_bought).times(s.price_usd_bought_leg ?? 0));
  }
  return summary;
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
async function valueInventoryAtTimestamp(lots, timestamp) {
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

/** Renders one line per distinct asset — quantity plus its USD market value at that point in time
 * (from valueInventoryAtTimestamp's already-aggregated perToken array) — followed by a total
 * value line. Shared by both Opening and Closing Inventory, which are otherwise identical in
 * shape. A null marketValueUsd (price didn't resolve — see valueInventoryAtTimestamp) shows as
 * "price unavailable" rather than a silent $0, and is excluded from the total rather than making
 * it read as lower than it really is. */
/** PDF-display-only number formatting: 2 decimal places, but the trailing ".00" is dropped
 * entirely when the rounded value has no fractional part — "10.000000" displays as "10",
 * "16.048500" as "16.05". Accepts a Decimal, a numeric string, or a plain number. Never touches
 * the underlying data (jsonArtifact keeps every value's full precision via Decimal#toString() —
 * this is purely how the PDF chooses to show a number, not what's actually stored/computed). */
function fmtAmount(value) {
  const num = value instanceof Decimal ? value.toNumber() : Number(value);
  if (!Number.isFinite(num)) return "—";
  const fixed = num.toFixed(2);
  return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
}

function renderInventorySection(doc, valuation, tokenMeta, emptyText) {
  if (valuation.perToken.length === 0) {
    doc.fontSize(10).fillColor(THEME.muted).text(emptyText);
    return;
  }
  let anyUnpriced = false;
  for (const t of valuation.perToken) {
    // NFTs never have a market-value feed for one specific token (see pnlPricing.js's composite-
    // key guard) — that's expected, not counted toward "excludes assets with no price data" below,
    // which is specifically about a genuine fungible-token pricing gap.
    const isNft = isNftAssetKey(t.tokenAddress);
    const usdText = isNft ? "cost basis only, no market feed" : t.marketValueUsd != null ? `$${fmtAmount(t.marketValueUsd)}` : "price unavailable";
    if (!isNft && t.marketValueUsd == null) anyUnpriced = true;
    const qtyText = isNft ? String(Number(t.quantity)) : fmtAmount(t.quantity);
    doc.fontSize(10).fillColor(THEME.bodyText).text(`${formatAssetLabel(t.tokenAddress, tokenMeta)}: ${qtyText}  —  ${usdText}`);
  }
  doc.moveDown(0.2);
  const totalNote = anyUnpriced ? " (excludes assets with no price data — see above)" : "";
  doc.fontSize(10).fillColor(THEME.white).font("Helvetica-Bold")
    .text(`Total value: $${fmtAmount(valuation.totalMarketValueUsd)}${totalNote}`);
  doc.font("Helvetica");
}

/** Groups realized disposal events by asset, summing cost basis/proceeds/gain-loss and counting
 * disposals per asset. NFTs roll up to their COLLECTION address (not the per-tokenId composite
 * key) — aggregating at the exact same granularity as the itemized table below would just
 * duplicate it one row per NFT; rolling up to the collection is what actually makes this a useful
 * summary when a wallet sold several different tokenIds from the same collection. Returns a Map
 * keyed by that aggregation key, preserving first-seen order (chronological, since events arrives
 * chronologically sorted) — not sorted by size, so the order matches how a reader would encounter
 * these assets reading the itemized table below it. */
function aggregateRealizedGains(events) {
  const byAsset = new Map();
  for (const e of events) {
    const aggKey = isNftAssetKey(e.tokenAddress) ? e.tokenAddress.split(":")[0] : e.tokenAddress;
    if (!byAsset.has(aggKey)) {
      byAsset.set(aggKey, { disposalCount: 0, costBasisUsd: new Decimal(0), proceedsUsd: new Decimal(0), gainLossUsd: new Decimal(0) });
    }
    const agg = byAsset.get(aggKey);
    agg.disposalCount++;
    agg.costBasisUsd = agg.costBasisUsd.plus(e.costBasisUsd);
    agg.proceedsUsd = agg.proceedsUsd.plus(e.proceedsUsd);
    agg.gainLossUsd = agg.gainLossUsd.plus(e.realizedPnlUsd);
  }
  return byAsset;
}

/** Table for the per-asset aggregate above the itemized Realized Gains & Losses table — same
 * explicit x/y + gutter approach as the other tables here, but simple enough (short, fixed number
 * of rows — one per distinct asset, never paginates) that it doesn't need drawHeaderRow/pagination
 * machinery of its own. */
/** Real column-aligned table for the "By Asset" aggregate — same explicit x/y positioning, gutter,
 * and manual pagination approach as renderRealizedGainsTable/renderTransactionTable below. Was
 * previously missing any page-break handling at all: for a wallet with enough distinct disposed
 * assets to overflow one page, pdfkit's own automatic pagination took over — which calls a *bare*
 * addPage() reverting to the document's original construction options (portrait), not this
 * section's landscape layout. Confirmed live on a real high-activity wallet's statement: a long
 * run of alternating portrait/landscape pages through the Realized Gains & Losses section, and
 * pages with unexplained blank space at the top (rows drawn past a landscape page's real bottom
 * edge because the overflow was never actually detected). Fixed by adopting the identical
 * pageOptions + bottomLimit + drawHeaderRow pattern already proven in renderRealizedGainsTable. */
function renderRealizedGainsAggregateTable(doc, aggregated, tokenMeta, pageOptions) {
  const left = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = [
    { label: "Asset", width: tableWidth * 0.40, align: "left" },
    { label: "Disposals", width: tableWidth * 0.12, align: "right" },
    { label: "Total Cost Basis", width: tableWidth * 0.16, align: "right" },
    { label: "Total Proceeds", width: tableWidth * 0.16, align: "right" },
    { label: "Total Gain / Loss", width: tableWidth * 0.16, align: "right" },
  ];
  let x = left;
  for (const col of cols) {
    col.x = x;
    x += col.width;
  }
  const GUTTER = 6;
  const rowHeight = 13;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHeaderRow() {
    const y = doc.y;
    doc.fontSize(8).font("Helvetica-Bold").fillColor(THEME.green);
    for (const col of cols) doc.text(col.label, col.x, y, { width: col.width - GUTTER, align: col.align, lineBreak: false });
    doc.font("Helvetica");
    doc.y = y + rowHeight;
    doc.moveTo(left, doc.y).lineTo(left + tableWidth, doc.y).strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.y += 4;
  }

  drawHeaderRow();
  for (const [assetKey, agg] of aggregated) {
    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage(pageOptions);
      doc.y = doc.page.margins.top;
      drawHeaderRow();
    }
    const y = doc.y;
    const gainColor = agg.gainLossUsd.isNegative() ? THEME.orange : THEME.green;
    doc.fontSize(8).fillColor(THEME.bodyText);
    doc.text(formatAssetLabel(assetKey, tokenMeta), cols[0].x, y, { width: cols[0].width - GUTTER, height: rowHeight, ellipsis: true });
    doc.text(String(agg.disposalCount), cols[1].x, y, { width: cols[1].width - GUTTER, align: "right", lineBreak: false });
    doc.text(`$${fmtAmount(agg.costBasisUsd)}`, cols[2].x, y, { width: cols[2].width - GUTTER, align: "right", lineBreak: false });
    doc.text(`$${fmtAmount(agg.proceedsUsd)}`, cols[3].x, y, { width: cols[3].width - GUTTER, align: "right", lineBreak: false });
    doc.fillColor(gainColor).text(`${agg.gainLossUsd.isNegative() ? "" : "+"}$${fmtAmount(agg.gainLossUsd)}`, cols[4].x, y, { width: cols[4].width - GUTTER, align: "right", lineBreak: false });
    doc.fillColor(THEME.bodyText);
    doc.y = y + rowHeight;
  }
  doc.x = left;
}

/** Real column-aligned table for Realized Gains & Losses — same explicit x/y positioning,
 * gutter, and manual pagination approach as renderTransactionTable below (kept as a separate
 * function rather than a shared generic-table abstraction, matching this codebase's existing
 * "fine to drift independently" convention for structurally-similar-but-distinct renderers — see
 * e.g. ingestSwaps/tokenChartRouter's independent GeckoTerminal queues). */
function renderRealizedGainsTable(doc, events, tokenMeta, pageOptions) {
  const left = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = [
    { label: "Date", width: tableWidth * 0.11, align: "left" },
    { label: "Asset", width: tableWidth * 0.37, align: "left" },
    { label: "Quantity", width: tableWidth * 0.13, align: "right" },
    { label: "Cost Basis", width: tableWidth * 0.13, align: "right" },
    { label: "Proceeds", width: tableWidth * 0.13, align: "right" },
    { label: "Gain / Loss", width: tableWidth * 0.13, align: "right" },
  ];
  let x = left;
  for (const col of cols) {
    col.x = x;
    x += col.width;
  }
  const GUTTER = 6;
  const rowHeight = 13;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHeaderRow() {
    const y = doc.y;
    doc.fontSize(8).font("Helvetica-Bold").fillColor(THEME.green);
    for (const col of cols) {
      doc.text(col.label, col.x, y, { width: col.width - GUTTER, align: col.align, lineBreak: false });
    }
    doc.font("Helvetica");
    doc.y = y + rowHeight;
    doc.moveTo(left, doc.y).lineTo(left + tableWidth, doc.y).strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.y += 4;
  }

  drawHeaderRow();
  for (const e of events) {
    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage(pageOptions);
      doc.y = doc.page.margins.top;
      drawHeaderRow();
    }
    const y = doc.y;
    const isNft = isNftAssetKey(e.tokenAddress);
    const gainLoss = e.realizedPnlUsd;
    const gainColor = gainLoss.isNegative() ? THEME.orange : THEME.green;
    const qtyText = isNft ? String(e.quantityConsumed) : fmtAmount(e.quantityConsumed);

    doc.fontSize(8).fillColor(THEME.bodyText);
    doc.text(e.timestamp.toISOString().slice(0, 10), cols[0].x, y, { width: cols[0].width - GUTTER, lineBreak: false });
    doc.text(formatAssetLabel(e.tokenAddress, tokenMeta), cols[1].x, y, { width: cols[1].width - GUTTER, height: rowHeight, ellipsis: true });
    doc.text(qtyText, cols[2].x, y, { width: cols[2].width - GUTTER, align: "right", lineBreak: false });
    doc.text(`$${fmtAmount(e.costBasisUsd)}`, cols[3].x, y, { width: cols[3].width - GUTTER, align: "right", lineBreak: false });
    doc.text(`$${fmtAmount(e.proceedsUsd)}`, cols[4].x, y, { width: cols[4].width - GUTTER, align: "right", lineBreak: false });
    doc.fillColor(gainColor).text(`${gainLoss.isNegative() ? "" : "+"}$${fmtAmount(gainLoss)}`, cols[5].x, y, { width: cols[5].width - GUTTER, align: "right", lineBreak: false });
    doc.fillColor(THEME.bodyText);
    doc.y = y + rowHeight;
  }
  doc.x = left;
}

/** Real column-aligned table for Transaction History — explicit x/y positioning rather than
 * pdfkit's normal flowing-text cursor, since laying out 6 columns on one row needs each field
 * placed at its own x with a fixed width (ellipsis-truncated if it overflows), not appended to a
 * moving cursor. Handles its own pagination (checking remaining vertical space before each row and
 * calling doc.addPage() itself) rather than relying on pdfkit's automatic per-text-call page
 * break, and redraws the header row on every new page it creates — a reader landing on any page of
 * a multi-page table still sees what each column means. */
function renderTransactionTable(doc, rows, pageOptions) {
  const left = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // Tx column sized from a real measurement, not a guess: a full 66-char tx hash at this font
  // size (8pt Helvetica) measures ~285pt — confirmed via doc.widthOfString before picking these
  // proportions, since lineBreak:false silently clips overflow rather than erroring. Asset shrinks
  // to make room (it already ellipsis-truncates gracefully, unlike the other columns).
  const cols = [
    { key: "date", label: "Date", width: tableWidth * 0.10, align: "left" },
    { key: "type", label: "Type", width: tableWidth * 0.07, align: "left" },
    { key: "asset", label: "Asset", width: tableWidth * 0.21, align: "left" },
    { key: "amount", label: "Amount", width: tableWidth * 0.09, align: "right" },
    { key: "usd", label: "USD", width: tableWidth * 0.09, align: "right" },
    { key: "tx", label: "Tx (full hash)", width: tableWidth * 0.44, align: "left" },
  ];
  let x = left;
  for (const col of cols) {
    col.x = x;
    x += col.width;
  }
  // Gutter reserved from each column's OWN width (not added on top) — column x-positions/
  // boundaries above stay based on the full width, so shrinking only the text-rendering width
  // leaves genuine blank space before the next column's x starts, on both left- and right-aligned
  // columns. Confirmed live this was needed: without it, a right-aligned column's text fills all
  // the way to its box's right edge, directly touching the next column's text with zero gap (the
  // header rendered as "USDTx" with no fix).
  const GUTTER = 6;
  const rowHeight = 13;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHeaderRow() {
    const y = doc.y;
    doc.fontSize(8).font("Helvetica-Bold").fillColor(THEME.green);
    for (const col of cols) {
      doc.text(col.label, col.x, y, { width: col.width - GUTTER, align: col.align, lineBreak: false });
    }
    doc.font("Helvetica");
    doc.y = y + rowHeight;
    doc.moveTo(left, doc.y).lineTo(left + tableWidth, doc.y).strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.y += 4;
  }

  drawHeaderRow();
  for (const row of rows) {
    if (doc.y + rowHeight > bottomLimit) {
      // Bare doc.addPage() would revert to the DOCUMENT's original construction options
      // (portrait) rather than continuing in whatever orientation the caller placed this table
      // in — pageOptions carries that through so a landscape table's overflow page is also
      // landscape, not a narrower portrait page the already-computed column widths don't fit.
      doc.addPage(pageOptions); // fires pageAdded -> paintBackground automatically
      doc.y = doc.page.margins.top;
      drawHeaderRow();
    }
    const y = doc.y;
    doc.fontSize(8).fillColor(THEME.bodyText);
    doc.text(row.timestamp.toISOString().slice(0, 16).replace("T", " "), cols[0].x, y, { width: cols[0].width - GUTTER, lineBreak: false });
    doc.text(row.type, cols[1].x, y, { width: cols[1].width - GUTTER, lineBreak: false });
    // ellipsis:true alone does NOT truncate to one line — confirmed live it just wraps normally
    // (silently corrupting every fixed-rowHeight row below it) unless a height constraint is also
    // given; rowHeight itself is that constraint here, same box the row's other cells use.
    doc.text(row.asset, cols[2].x, y, { width: cols[2].width - GUTTER, height: rowHeight, ellipsis: true });
    doc.text(row.amount, cols[3].x, y, { width: cols[3].width - GUTTER, align: cols[3].align, lineBreak: false });
    doc.text(row.usd, cols[4].x, y, { width: cols[4].width - GUTTER, align: cols[4].align, lineBreak: false });
    doc.fillColor(THEME.green).text(row.txHash || "—", cols[5].x, y, {
      width: cols[5].width - GUTTER,
      lineBreak: false,
      link: `${EXPLORER_BASE_URL}/tx/${row.txHash}`,
      underline: true,
    });
    doc.fillColor(THEME.bodyText);
    doc.y = y + rowHeight;
  }
}

/** Builds the chronological, page-spanning transaction list — every in-period transfer (native +
 * token, excluding pure gas-fee bookkeeping rows, which have no asset movement of their own and
 * are already totaled in the Fees summary) plus every in-period swap, sorted oldest first. This is
 * the literal ledger a statement's "Transaction History" table shows — separate from
 * realizedPnlEvents (FIFO disposals only) and from the flows/gas totals (aggregated, not
 * itemized). Each item is pre-formatted into the exact column strings the table renders (date,
 * type, asset, amount, usd, tx) rather than one joined line, so buildPdf can lay them out as real
 * table columns instead of parsing a sentence back apart. */
function buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta, cexAddressSet) {
  const items = [];
  for (const t of transfersInPeriod) {
    if (t.gas_fee_wei != null || Number(t.amount_raw) === 0) continue;
    const isNft = NFT_ASSET_TYPES.has(t.asset_type);
    const assetKey = isNft ? nftAssetKey(t) : t.token_address || NATIVE_SENTINEL;
    // NFT quantity is always a whole count (1 per unique ERC-721, or an ERC-1155 batch amount) —
    // ".000000" on an NFT line reads as a fungible-token artifact, not as "1 of something unique".
    const amount = isNft ? String(Number(t.amount_decimal)) : fmtAmount(t.amount_decimal);
    // cexAddressSet (loaded fresh in generateStatement), not the row's own stored is_cex — that
    // flag is computed and baked in once, at ingestion time, and ingestion is incremental (only
    // scans blocks newer than last_ingested_block). Confirmed live: a CEX address added to
    // cex_addresses *after* a wallet's history was already fully ingested never retroactively
    // applied to already-ingested rows, no matter how many times the statement was regenerated —
    // there was nothing new left to ingest, so the stale is_cex=false on every existing row never
    // got revisited. Recomputing live here means adding a CEX address always takes effect on the
    // very next regeneration, for every wallet, not just newly-ingested activity.
    const tag = t.is_self_transfer ? " (self)" : cexAddressSet.has(String(t.counterparty_address).toLowerCase()) ? " (CEX)" : "";
    // NFTs never have a fungible-market usd_value (see pnlPricing.js's early guard on composite
    // keys) — its cost basis/proceeds, if this leg turned out to be a mint/sale, show separately in
    // Realized Gains & Losses instead; showing "price unavailable" here would misleadingly suggest
    // a missing market feed rather than "this is correctly a non-priced asset".
    const usd = isNft ? "n/a" : t.usd_value != null ? `$${fmtAmount(t.usd_value)}` : "unavailable";
    items.push({
      timestamp: new Date(t.timestamp),
      txHash: t.tx_hash,
      type: `${t.direction === "in" ? "IN" : "OUT"}${tag}`,
      asset: formatAssetLabel(assetKey, tokenMeta),
      amount,
      usd,
    });
  }
  for (const s of swapsInPeriod) {
    items.push({
      timestamp: new Date(s.timestamp),
      txHash: s.tx_hash,
      type: "SWAP",
      asset: `${formatAssetLabel(s.token_sold_address, tokenMeta)} -> ${formatAssetLabel(s.token_bought_address, tokenMeta)}`,
      amount: `${fmtAmount(s.amount_sold)} -> ${fmtAmount(s.amount_bought)}`,
      usd: "—",
    });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function buildPdf({ request, periodStart, periodEnd, blockRange, openingValuation, closingValuation, gas, flows, gameActivity, defiActivitySummary, realizedPnlUsd, unrealizedPnlUsd, netPnlUsd, tokenMeta, transactionLines, priceCoverageDisclaimer, nftDisclaimer, ensName, realizedEventsInPeriod, realizedGainsByAsset }) {
  const PORTRAIT = { margin: 50, layout: "portrait" };
  const LANDSCAPE = { margin: 50, layout: "landscape" };
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  let hasOrbitron = true;
  try {
    doc.registerFont("Orbitron-Bold", ORBITRON_BOLD_PATH);
  } catch (err) {
    hasOrbitron = false;
    console.warn("⚠️  Statement PDF: could not register Orbitron-Bold, falling back to Helvetica-Bold:", err.message);
  }
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Dark background on every page, including ones pdfkit auto-adds when content overflows (the
  // transaction table below can easily run to several pages for an active wallet) — pageAdded
  // fires after the new page exists but before anything's drawn on it, and .rect().fill() changes
  // the current fill color as a side effect, so every draw call below re-sets its own color rather
  // than assuming what the background fill left behind.
  const paintBackground = () => doc.rect(0, 0, doc.page.width, doc.page.height).fill(THEME.background);
  paintBackground();
  doc.on("pageAdded", paintBackground);

  // Page-number tracking for the Contents block below — a second, independent 'pageAdded'
  // listener (pdfkit supports multiple listeners on the same event) rather than folding this into
  // paintBackground, so the two concerns stay easy to reason about separately. Fires for every
  // addPage() call anywhere, including renderTransactionTable's own internal overflow pagination,
  // so this stays accurate even when a section's table itself spans several pages.
  let currentPageNumber = 1;
  doc.on("pageAdded", () => { currentPageNumber++; });
  const sectionPageNumbers = {};

  const sectionHeader = (text) => {
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(THEME.green).font("Helvetica-Bold").text(text);
    doc.moveDown(0.3);
  };

  // Header: logo + wordmark as a compact top-left letterhead mark, not a centered hero banner.
  const logoHeight = 28;
  const logoY = doc.y;
  const logoX = doc.page.margins.left;
  try {
    doc.image(LOGO_PATH, logoX, logoY, { height: logoHeight });
    doc.image(WORDMARK_PATH, logoX + logoHeight + 10, logoY + 5, { height: 18 });
  } catch (err) {
    console.warn("⚠️  Statement PDF: could not embed logo/wordmark images:", err.message);
  }
  doc.y = logoY + logoHeight + 14;

  doc.font(hasOrbitron ? "Orbitron-Bold" : "Helvetica-Bold").fontSize(18).fillColor(THEME.white)
    .text("Electroneum Profit & Loss Statement");
  doc.font("Helvetica");
  doc.moveDown(0.3);
  // Replaces the old static "Planet Zephyros — Electroneum Dashboard" subtitle with a real,
  // clickable link back to the dashboard's Premium tab — lets anyone reading a shared/printed
  // statement get straight to requesting another one.
  // Plain "->" rather than a Unicode arrow — same font-glyph issue as the ⚠ character above:
  // Helvetica's table doesn't include "→" either, and it silently renders as garbage instead.
  doc.fontSize(10).fillColor(THEME.green).text("Request another statement ->", { link: PREMIUM_TAB_URL, underline: true });
  doc.moveDown(1);

  doc.fillColor(THEME.bodyText).fontSize(11);
  doc.text(`Wallet: ${request.tracked_wallet}${ensName ? `  (${ensName})` : ""}`);
  doc.text(`Reporting period: ${periodTypeLabel(request.period_type)} ${request.year}`);
  doc.text(`Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
  if (blockRange) {
    doc.fillColor(THEME.muted).text(`Block range: ${blockRange.startBlock} to ${blockRange.endBlock} (for cross-checking against the block explorer — see the explanation below)`);
    doc.fillColor(THEME.bodyText);
  }
  doc.text(`Request ID: ${request.id}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  if (priceCoverageDisclaimer) {
    doc.moveDown(0.4);
    // Plain text, no leading symbol — an earlier version prefixed this with the ⚠ Unicode
    // character, which isn't in Helvetica's glyph table and rendered as a stray "&" instead.
    // Orange fill color alone is enough visual distinction, matching the muted-color treatment
    // the Block range note above already uses.
    doc.fontSize(9).fillColor(THEME.orange).text(priceCoverageDisclaimer);
    doc.fillColor(THEME.bodyText).fontSize(11);
  }
  if (nftDisclaimer) {
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor(THEME.orange).text(nftDisclaimer);
    doc.fillColor(THEME.bodyText).fontSize(11);
  }
  doc.moveDown(1);

  // Contents — page numbers aren't known yet (they depend on how much content later sections
  // take up), so this reserves blank lines now, at fontSize 10, remembering each entry's exact Y
  // position, then gets overwritten with the real page numbers via switchToPage() right before
  // doc.end() once every section's actual starting page is known. Entry list matches the
  // sectionHeader() calls below exactly, including Game Activity being conditional.
  const contentsEntries = ["Summary", "Opening Inventory", "Closing Inventory", "Realized Gains & Losses"];
  if (gameActivity.size > 0) contentsEntries.push("Game Activity");
  if (defiActivitySummary.size > 0) contentsEntries.push("DeFi / Yield Farming");
  contentsEntries.push("Transaction History", "Understanding This Statement");
  const contentsPageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(10).fillColor(THEME.white).font("Helvetica-Bold").text("Contents");
  doc.font("Helvetica").fillColor(THEME.bodyText).fontSize(10);
  const contentsEntryYs = [];
  for (let i = 0; i < contentsEntries.length; i++) {
    contentsEntryYs.push(doc.y);
    doc.text(" ");
  }
  doc.moveDown(1);

  const line = (label, value) => doc.fontSize(11).fillColor(THEME.bodyText).text(`${label}: ${value}`);

  sectionPageNumbers["Summary"] = currentPageNumber;
  sectionHeader("Summary");
  line("On-chain inflows (USD)", fmtAmount(flows.onChainIn));
  line("On-chain outflows (USD)", fmtAmount(flows.onChainOut));
  line("CEX deposits (USD)", fmtAmount(flows.cexIn));
  line("CEX withdrawals (USD)", fmtAmount(flows.cexOut));
  doc.moveDown(0.5);
  line("Gas fees paid (ETN)", fmtAmount(gas.totalGasEtn));
  line("Gas fees paid (USD)", fmtAmount(gas.totalGasUsd));
  doc.moveDown(0.5);
  line("Realized P&L (USD)", fmtAmount(realizedPnlUsd));
  line("Unrealized P&L (USD)", fmtAmount(unrealizedPnlUsd));
  doc.moveDown(0.3);
  doc.fontSize(13).fillColor(THEME.white).font("Helvetica-Bold").text(`Net P&L after fees (USD): ${fmtAmount(netPnlUsd)}`);
  doc.font("Helvetica");
  doc.moveDown(1);

  sectionPageNumbers["Opening Inventory"] = currentPageNumber;
  sectionHeader("Opening Inventory");
  renderInventorySection(doc, openingValuation, tokenMeta, "No open positions at period start (this appears to be the wallet's first reporting period).");
  doc.moveDown(1);

  sectionPageNumbers["Closing Inventory"] = currentPageNumber;
  sectionHeader("Closing Inventory");
  renderInventorySection(doc, closingValuation, tokenMeta, "No open positions at period end.");
  doc.moveDown(1);

  // Realized Gains & Losses and Transaction History both get their own landscape page — wider
  // rows read far better for these two specifically (long asset labels, tabular data) than the
  // portrait layout the rest of the statement uses.
  doc.addPage(LANDSCAPE);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
  sectionPageNumbers["Realized Gains & Losses"] = currentPageNumber;
  sectionHeader("Realized Gains & Losses");
  if (!realizedEventsInPeriod || realizedEventsInPeriod.length === 0) {
    doc.fontSize(10).fillColor(THEME.muted).text("No disposals (sales, swaps, or NFT sales) in this period.");
  } else {
    doc.fontSize(10).fillColor(THEME.white).font("Helvetica-Bold").text("By Asset");
    doc.font("Helvetica");
    doc.moveDown(0.2);
    renderRealizedGainsAggregateTable(doc, realizedGainsByAsset, tokenMeta, LANDSCAPE);
    doc.moveDown(0.8);

    doc.fontSize(10).fillColor(THEME.white).font("Helvetica-Bold").text("Every Disposal");
    doc.font("Helvetica");
    doc.moveDown(0.2);
    renderRealizedGainsTable(doc, realizedEventsInPeriod, tokenMeta, LANDSCAPE);
    doc.x = doc.page.margins.left;
  }
  doc.moveDown(1);

  if (gameActivity.size > 0) {
    sectionPageNumbers["Game Activity"] = currentPageNumber;
    sectionHeader("Game Activity");
    doc.fontSize(9).fillColor(THEME.muted).text("Already counted in Realized Gains & Losses above — shown again here as a labeled breakdown, not an additional amount.");
    doc.moveDown(0.3);
    doc.fontSize(10);
    for (const [name, g] of gameActivity) {
      const net = g.wonUsd.minus(g.wageredUsd);
      const netColor = net.isNegative() ? THEME.orange : THEME.green;
      const unpricedNote = g.wageredUnpriced + g.wonUnpriced > 0 ? `  (${g.wageredUnpriced + g.wonUnpriced} transaction(s) with no price data, not included above)` : "";
      doc.fillColor(THEME.bodyText).text(`${name} — Wagered: $${fmtAmount(g.wageredUsd)}, Won: $${fmtAmount(g.wonUsd)}, `, { continued: true });
      doc.fillColor(netColor).text(`Net: ${net.isNegative() ? "" : "+"}$${fmtAmount(net)}`, { continued: unpricedNote.length > 0 });
      if (unpricedNote) doc.fillColor(THEME.muted).text(unpricedNote);
    }
    doc.moveDown(1);
  }

  if (defiActivitySummary.size > 0) {
    sectionPageNumbers["DeFi / Yield Farming"] = currentPageNumber;
    sectionHeader("DeFi / Yield Farming");
    doc.fontSize(9).fillColor(THEME.muted).text(
      "Deposits and withdrawals are already counted in Realized Gains & Losses above (treated as a disposal at deposit and a reacquisition at withdrawal, at fair market value). Rewards are recorded at $0 cost basis when received and only affect Net P&L later if you go on to sell, swap, or send them to an exchange — this line shows their value at the time received purely for visibility, not as income already counted above."
    );
    doc.moveDown(0.3);
    doc.fontSize(10);
    for (const [name, d] of defiActivitySummary) {
      const unpricedNote = d.unpriced > 0 ? `  (${d.unpriced} amount(s) with no price data, not included above)` : "";
      doc.fillColor(THEME.bodyText).text(`${name} — Deposited: $${fmtAmount(d.depositedUsd)}, Withdrawn: $${fmtAmount(d.withdrawnUsd)}, Rewards Earned: $${fmtAmount(d.rewardsUsd)}`, { continued: unpricedNote.length > 0 });
      if (unpricedNote) doc.fillColor(THEME.muted).text(unpricedNote);
    }
    doc.moveDown(1);
  }

  doc.addPage(LANDSCAPE);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
  sectionPageNumbers["Transaction History"] = currentPageNumber;
  sectionHeader("Transaction History");
  if (transactionLines.length === 0) {
    doc.fontSize(10).fillColor(THEME.muted).text("No transactions in this period.");
  } else {
    renderTransactionTable(doc, transactionLines, LANDSCAPE);
  }
  // renderTransactionTable positions every cell with explicit x/y — without this, doc.x is left
  // wherever the last column was (the Tx column, far right), and the next plain-flowing .text()
  // call (Understanding This Statement's header) would start from THAT stale x instead of the
  // page's left margin, visually landing inside the table's own column area. Confirmed live: this
  // was exactly the "Understanding This Statement looks like it's gone into the table" bug.
  doc.x = doc.page.margins.left;
  doc.moveDown(1);

  doc.addPage(PORTRAIT);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
  sectionPageNumbers["Understanding This Statement"] = currentPageNumber;
  sectionHeader("Understanding This Statement");
  doc.fontSize(9);
  for (const [label, explanation] of SUMMARY_EXPLANATIONS) {
    doc.fillColor(THEME.white).font("Helvetica-Bold").text(label);
    doc.fillColor(THEME.muted).font("Helvetica").text(explanation);
    doc.moveDown(0.4);
  }
  if (blockRange) {
    doc.fillColor(THEME.white).font("Helvetica-Bold").text("Block range");
    doc.fillColor(THEME.muted).font("Helvetica").text(
      "The Block range shown above is derived by looking up which block was nearest each period boundary's exact timestamp — it's provided so you can independently cross-check this statement's activity against the block explorer directly. It is not what this statement itself used to decide which transactions to include: that decision is based on each transaction's own timestamp falling within the period, not its block number."
    );
    doc.moveDown(0.4);
  }
  if (priceCoverageDisclaimer) {
    doc.fillColor(THEME.white).font("Helvetica-Bold").text("Price data availability");
    doc.fillColor(THEME.muted).font("Helvetica").text(
      `${priceCoverageDisclaimer} This reflects a real limit of the underlying free price data sources (they only expose a recent rolling window, not full history), not a bug in how this statement was produced — every figure that IS shown is a real historical price, never an estimate or placeholder.`
    );
    doc.moveDown(0.4);
  }
  doc.fillColor(THEME.white).font("Helvetica-Bold").text("Realized Gains & Losses");
  doc.fillColor(THEME.muted).font("Helvetica").text(
    "Every disposal in the period — a token sale, a swap, or an NFT sale — with its cost basis (what you originally paid), proceeds (what you received), and the resulting gain or loss. For a mint or purchase followed later by a sale, cost basis is whatever ETN/token payment was found in the exact same transaction as the acquisition; proceeds work the same way for the sale side. NFT gains/losses appear here exactly the same as fungible token ones — an NFT minted for 1,000 ETN and later sold for 10,000 ETN shows as a single +9,000 (in USD terms) line."
  );
  doc.moveDown(0.4);
  if (nftDisclaimer) {
    doc.fillColor(THEME.white).font("Helvetica-Bold").text("NFT cost basis / proceeds matching");
    doc.fillColor(THEME.muted).font("Helvetica").text(nftDisclaimer);
    doc.moveDown(0.4);
  }
  if (defiActivitySummary.size > 0) {
    doc.fillColor(THEME.white).font("Helvetica-Bold").text("DeFi / Yield Farming");
    doc.fillColor(THEME.muted).font("Helvetica").text(
      "Yield farm and staking contracts you interacted with are detected automatically by their on-chain event signatures, not a manually maintained list — any future farm/stake deployed from the same contract template is picked up the same way. Depositing into a farm or stake is treated as disposing of the deposited token(s) at their market value at that moment (a taxable event, same as a sale); withdrawing principal is treated as reacquiring whatever comes back, at its market value at that moment. Rewards (a farm's own reward token, LP fees, third-party rewards, staking rewards) are recorded as acquired at $0 cost basis — they don't count as income when received, only affect Net P&L later if you go on to sell, swap, or send them to an exchange."
    );
    doc.moveDown(0.4);
  }
  doc.moveDown(0.6);

  doc.fontSize(8).fillColor(THEME.muted).text(DISCLAIMER, { align: "left" });

  // Every section's real starting page is known now — go back to page 1 (bufferPages:true keeps
  // every page in memory until end() actually flushes them, so this is safe) and overwrite the
  // blank lines reserved earlier with the real Contents entries. switchToPage only changes where
  // subsequent draw calls target; it doesn't need to be switched back afterward — end() flushes
  // every buffered page regardless of which one is "current".
  doc.switchToPage(0);
  doc.fontSize(10).font("Helvetica").fillColor(THEME.bodyText);
  for (let i = 0; i < contentsEntries.length; i++) {
    const label = contentsEntries[i];
    const pageNum = sectionPageNumbers[label] ?? "?";
    const dots = ".".repeat(Math.max(2, 55 - label.length - String(pageNum).length));
    doc.text(`${label} ${dots} ${pageNum}`, doc.page.margins.left, contentsEntryYs[i], { width: contentsPageWidth, lineBreak: false });
  }

  doc.end();
  return done;
}

/** Generates and freezes the statement for `requestId`. Expects the request to already be
 * PENDING_GENERATION (see pnlStatementRouter.js's /request endpoint). Idempotent to call again on
 * a GENERATED/FINALIZED request only in the sense that markGenerated's own WHERE clause simply
 * won't apply a second time — callers should not call this on an already-generated request. */
export async function generateStatement(requestId) {
  const generationStartedAt = new Date();
  console.log(`📄 Statement generation started for request ${requestId} at ${generationStartedAt.toISOString()}`);

  const request = await getById(requestId);
  if (!request) throw new Error(`Statement request ${requestId} not found`);
  if (request.status !== "PENDING_GENERATION") {
    throw new Error(`Statement request ${requestId} is ${request.status}, not PENDING_GENERATION — refusing to generate`);
  }

  // Always recomputed from (period_type, year) via this backend's own calendar math — never
  // trusts the on-chain periodEnd the contract validated at payment time as the real slice
  // boundary (see periodTypes.js's header comment and the confirmed "backend validates the
  // shape" decision). A mismatched/gamed on-chain claim can't be used to underpay; it just can't
  // produce a statement for anything other than the real (period_type, year) it names.
  const { periodStart, periodEnd } = computePeriodBoundaries(request.period_type, request.year);
  if (periodEnd > new Date()) {
    throw new Error(`Statement request ${requestId}'s period ends ${periodEnd.toISOString()}, which hasn't happened yet — cannot generate a statement for a future period`);
  }

  // Purely cosmetic (shown alongside the raw address, never replacing it) — a lookup failure here
  // must never fail statement generation over something this minor.
  const ensName = await resolveEnsDisplayName(request.tracked_wallet).catch(() => null);

  const selfOwnedAddresses = Array.isArray(request.self_owned_addresses) ? request.self_owned_addresses : [];
  await ingestWalletHistory(request.tracked_wallet, selfOwnedAddresses);

  const [transfers, swaps, defiActivity] = await Promise.all([
    getAllTransfersBefore(request.tracked_wallet, periodEnd),
    getAllSwapTradesBefore(request.tracked_wallet, periodEnd),
    getAllDefiActivityBefore(request.tracked_wallet, periodEnd),
  ]);

  // NFT legs are pulled out and turned into their own mint/purchase/sale FIFO events (see
  // buildNftEvents) BEFORE the generic transferToEvent mapping runs, so consumedRowIds excludes
  // them there — an NFT leg must never be fed into FIFO both as a generic zero-priced transfer AND
  // as a properly cost-tracked NFT event.
  const { events: nftEvents, consumedRowIds: nftConsumedRowIds, unmatchedCount: nftUnmatchedCount } = buildNftEvents(transfers);
  // Yield-farm/staking deposits, withdrawals, and reward claims — see buildDefiFarmEvents' own
  // header comment for the exact tax treatment (disposal+reacquisition for principal, zero-cost-
  // basis acquisition for rewards). Resolved over the wallet's FULL history (like transfers/swaps
  // above), not just this period, so opening inventory correctly reflects farm/stake activity from
  // prior periods too.
  const { events: defiEvents } = await buildDefiFarmEvents(defiActivity);
  const events = [
    ...transfers.filter((t) => !nftConsumedRowIds.has(t.id)).map(transferToEvent),
    ...swaps.map(swapToEvent),
    ...nftEvents,
    ...defiEvents,
  ].sort((a, b) => a.timestamp - b.timestamp);
  const { opening, closing } = replayFifo(events, periodStart, periodEnd);

  const transfersInPeriod = transfers.filter((t) => {
    const ts = new Date(t.timestamp);
    return ts >= periodStart && ts < periodEnd;
  });
  const swapsInPeriod = swaps.filter((s) => {
    const ts = new Date(s.timestamp);
    return ts >= periodStart && ts < periodEnd;
  });
  const defiActivityInPeriod = defiActivity.filter((row) => {
    const ts = new Date(row.timestamp);
    return ts >= periodStart && ts < periodEnd;
  });
  // Re-run just for the labeled breakdown, scoped to this period only (mirrors
  // transfersInPeriod/swapsInPeriod above) — cheap: every contract/farm view-function read and
  // price lookup here already got cached by the full-history call just above.
  const { perLabel: defiActivitySummary } = await buildDefiFarmEvents(defiActivityInPeriod);

  const [gas, closingValuation, openingValuation, cexAddressList] = await Promise.all([
    computeGasFeesUsd(transfersInPeriod),
    valueInventoryAtTimestamp(closing.lots, periodEnd),
    valueInventoryAtTimestamp(opening.lots, periodStart),
    listCexAddresses(),
  ]);
  // Loaded fresh on every generation (not trusted from the stored per-row is_cex flag) — see
  // buildTransactionLines' own comment on why that flag can go stale.
  const cexAddressSet = new Set(cexAddressList.map((r) => r.address.toLowerCase()));
  const flows = summarizeFlows(transfersInPeriod, swapsInPeriod, cexAddressSet);
  const gameActivity = buildGameActivitySummary(transfersInPeriod);

  const realizedEventsInPeriod = closing.realizedEvents.filter((e) => e.timestamp >= periodStart);
  const realizedGainsByAsset = aggregateRealizedGains(realizedEventsInPeriod);
  const realizedPnlUsd = realizedEventsInPeriod.reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  const netPnlUsd = realizedPnlUsd.plus(closingValuation.totalUnrealizedUsd).minus(gas.totalGasUsd);

  // Informational only (see getBlockByTimestamp's own comment) — never lets a lookup failure fail
  // the whole statement, since this is purely a cross-checking convenience, not load-bearing data.
  let blockRange = null;
  try {
    const [startBlock, endBlock] = await Promise.all([
      getBlockByTimestamp(periodStart, "after"),
      getBlockByTimestamp(periodEnd, "before"),
    ]);
    blockRange = { startBlock, endBlock };
    console.log(`📄 Statement ${requestId}: period ${periodStart.toISOString()} to ${periodEnd.toISOString()} resolved to blocks ${startBlock}-${endBlock}`);
  } catch (err) {
    console.warn(`⚠️  Statement generator: could not resolve block range for request ${requestId}:`, err.message);
  }

  const { tokenMeta, addresses: tokenAddresses } = await collectTokenMetadata(opening.lots, closing.lots, closingValuation.perToken, realizedEventsInPeriod, transfersInPeriod, swapsInPeriod);
  const withAssetLabel = (obj, tokenAddress) => ({ ...obj, tokenAddress, assetLabel: formatAssetLabel(tokenAddress, tokenMeta) });
  const transactionLines = buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta, cexAddressSet);
  const priceCoverageDisclaimer = await buildPriceCoverageDisclaimer(periodStart, [...tokenAddresses]);
  const nftDisclaimer = nftUnmatchedCount > 0
    ? `${nftUnmatchedCount} NFT transfer${nftUnmatchedCount === 1 ? "" : "s"} in this wallet's history had no matching payment found in the same transaction — recorded with $0 cost basis / proceeds for that leg. This is correct for a genuine free mint, airdrop, or gift; it would understate a real cost or gain if the actual payment happened in a separate transaction from the NFT transfer itself.`
    : null;

  const jsonArtifact = {
    schemaVersion: 1,
    requestId: request.id,
    trackedWallet: request.tracked_wallet,
    trackedWalletEnsName: ensName,
    periodType: request.period_type,
    periodTypeLabel: periodTypeLabel(request.period_type),
    year: request.year,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    blockRange,
    generatedAt: new Date().toISOString(),
    priceCoverageDisclaimer,
    nftDisclaimer,
    nftUnmatchedCount,
    // Breakdown only — already counted in realizedPnlEvents/summary above, not additive to it.
    gameActivity: [...gameActivity.entries()].map(([name, g]) => ({
      name,
      wageredUsd: g.wageredUsd.toString(),
      wonUsd: g.wonUsd.toString(),
      netUsd: g.wonUsd.minus(g.wageredUsd).toString(),
    })),
    // Breakdown only — deposits/withdrawals are already counted in realizedPnlEvents above (a
    // disposal+reacquisition, per buildDefiFarmEvents' header comment); rewards are already
    // counted in the FIFO ledger at $0 cost basis, so they only surface in Net P&L later if/when
    // actually disposed of. Not additive to Net P&L on its own.
    defiActivity: [...defiActivitySummary.entries()].map(([name, d]) => ({
      name,
      depositedUsd: d.depositedUsd.toString(),
      withdrawnUsd: d.withdrawnUsd.toString(),
      rewardsUsd: d.rewardsUsd.toString(),
    })),
    openingInventory: {
      totalValueUsd: openingValuation.totalMarketValueUsd.toString(),
      perAsset: openingValuation.perToken.map((t) => withAssetLabel(t, t.tokenAddress)),
    },
    closingInventory: {
      totalValueUsd: closingValuation.totalMarketValueUsd.toString(),
      perAsset: closingValuation.perToken.map((t) => withAssetLabel(t, t.tokenAddress)),
    },
    flows: { onChainIn: flows.onChainIn.toString(), onChainOut: flows.onChainOut.toString(), cexIn: flows.cexIn.toString(), cexOut: flows.cexOut.toString() },
    fees: { gasEtn: gas.totalGasEtn, gasUsd: gas.totalGasUsd.toString() },
    // Per-asset totals — NFTs rolled up to their collection address (see aggregateRealizedGains's
    // own comment on why: aggregating at the exact per-tokenId key would just duplicate
    // realizedPnlEvents below one-for-one).
    realizedGainsByAsset: [...realizedGainsByAsset.entries()].map(([assetKey, agg]) => withAssetLabel({
      disposalCount: agg.disposalCount,
      costBasisUsd: agg.costBasisUsd.toString(),
      proceedsUsd: agg.proceedsUsd.toString(),
      realizedPnlUsd: agg.gainLossUsd.toString(),
    }, assetKey)),
    realizedPnlEvents: realizedEventsInPeriod.map((e) => withAssetLabel({
      disposalTxHash: e.disposalTxHash,
      timestamp: e.timestamp.toISOString(),
      quantityConsumed: e.quantityConsumed.toString(),
      costBasisUsd: e.costBasisUsd.toString(),
      proceedsUsd: e.proceedsUsd.toString(),
      realizedPnlUsd: e.realizedPnlUsd.toString(),
    }, e.tokenAddress)),
    unrealizedPnl: {
      totalUsd: closingValuation.totalUnrealizedUsd.toString(),
      perToken: closingValuation.perToken.map((t) => withAssetLabel(t, t.tokenAddress)),
    },
    // Every in-period transfer/swap, chronological — the same ledger the PDF's Transaction History
    // pages show (see buildTransactionLines), just machine-readable here instead of pre-formatted.
    transactions: transactionLines.map((item) => ({
      timestamp: item.timestamp.toISOString(),
      type: item.type,
      asset: item.asset,
      amount: item.amount,
      usd: item.usd,
      txHash: item.txHash,
    })),
    summary: { realizedPnlUsd: realizedPnlUsd.toString(), unrealizedPnlUsd: closingValuation.totalUnrealizedUsd.toString(), netPnlAfterFeesUsd: netPnlUsd.toString() },
    summaryExplanations: Object.fromEntries(SUMMARY_EXPLANATIONS),
    disclaimer: DISCLAIMER,
  };

  const pdfBuffer = await buildPdf({ request, periodStart, periodEnd, blockRange, openingValuation, closingValuation, gas, flows, gameActivity, defiActivitySummary, realizedPnlUsd, unrealizedPnlUsd: closingValuation.totalUnrealizedUsd, netPnlUsd, tokenMeta, transactionLines, priceCoverageDisclaimer, nftDisclaimer, ensName, realizedEventsInPeriod, realizedGainsByAsset });

  const baseKey = `pnl-statements/${request.tracked_wallet.toLowerCase()}/${request.id}`;
  const jsonKey = `${baseKey}.json`;
  const pdfKey = `${baseKey}.pdf`;

  await Promise.all([
    uploadStatementArtifact(JSON.stringify(jsonArtifact, null, 2), jsonKey, "application/json"),
    uploadStatementArtifact(pdfBuffer, pdfKey, "application/pdf"),
  ]);

  const updated = await markGenerated(requestId, { artifactPdfKey: pdfKey, artifactJsonKey: jsonKey });
  const totalSec = Math.round((Date.now() - generationStartedAt.getTime()) / 1000);
  console.log(`📄 Statement generated for request ${requestId} (wallet ${request.tracked_wallet}, net P&L $${netPnlUsd.toFixed(2)}) — started ${generationStartedAt.toISOString()}, took ${totalSec}s`);
  return updated;
}
