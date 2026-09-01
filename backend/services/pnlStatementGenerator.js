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
const PREMIUM_TAB_URL = "https://dashboard.planetzephyros.xyz/premium";

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
        const unitCostUsd = paymentLeg?.usd_value != null ? Number(paymentLeg.usd_value) / quantity : 0;
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
        const proceedsUsd = proceedsLeg?.usd_value != null ? Number(proceedsLeg.usd_value) : 0;
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

function summarizeFlows(transfersInPeriod, swapsInPeriod) {
  // Categorized purely for the statement's readable line items — the FIFO math itself doesn't
  // care about these categories, only about in/out/self/swap (see transferToEvent above).
  const summary = { onChainIn: new Decimal(0), onChainOut: new Decimal(0), cexIn: new Decimal(0), cexOut: new Decimal(0) };
  for (const t of transfersInPeriod) {
    if (t.gas_fee_wei != null || Number(t.amount_raw) === 0 || t.is_self_transfer) continue;
    const usd = new Decimal(t.usd_value ?? 0);
    if (t.is_cex) {
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
    const usdText = isNft ? "cost basis only, no market feed" : t.marketValueUsd != null ? `$${Number(t.marketValueUsd).toFixed(2)}` : "price unavailable";
    if (!isNft && t.marketValueUsd == null) anyUnpriced = true;
    const qtyText = isNft ? String(Number(t.quantity)) : Number(t.quantity).toFixed(6);
    doc.fontSize(10).fillColor(THEME.bodyText).text(`${formatAssetLabel(t.tokenAddress, tokenMeta)}: ${qtyText}  —  ${usdText}`);
  }
  doc.moveDown(0.2);
  const totalNote = anyUnpriced ? " (excludes assets with no price data — see above)" : "";
  doc.fontSize(10).fillColor(THEME.white).font("Helvetica-Bold")
    .text(`Total value: $${valuation.totalMarketValueUsd.toFixed(2)}${totalNote}`);
  doc.font("Helvetica");
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—";
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
  const cols = [
    { key: "date", label: "Date", width: tableWidth * 0.16, align: "left" },
    { key: "type", label: "Type", width: tableWidth * 0.10, align: "left" },
    { key: "asset", label: "Asset", width: tableWidth * 0.34, align: "left" },
    { key: "amount", label: "Amount", width: tableWidth * 0.16, align: "right" },
    { key: "usd", label: "USD", width: tableWidth * 0.12, align: "right" },
    { key: "tx", label: "Tx", width: tableWidth * 0.12, align: "left" },
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
    doc.fillColor(THEME.green).text(shortHash(row.txHash), cols[5].x, y, {
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
function buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta) {
  const items = [];
  for (const t of transfersInPeriod) {
    if (t.gas_fee_wei != null || Number(t.amount_raw) === 0) continue;
    const isNft = NFT_ASSET_TYPES.has(t.asset_type);
    const assetKey = isNft ? nftAssetKey(t) : t.token_address || NATIVE_SENTINEL;
    // NFT quantity is always a whole count (1 per unique ERC-721, or an ERC-1155 batch amount) —
    // ".000000" on an NFT line reads as a fungible-token artifact, not as "1 of something unique".
    const amount = isNft ? String(Number(t.amount_decimal)) : Number(t.amount_decimal).toFixed(6);
    const tag = t.is_self_transfer ? " (self)" : t.is_cex ? " (CEX)" : "";
    // NFTs never have a fungible-market usd_value (see pnlPricing.js's early guard on composite
    // keys) — its cost basis/proceeds, if this leg turned out to be a mint/sale, show separately in
    // Realized Gains & Losses instead; showing "price unavailable" here would misleadingly suggest
    // a missing market feed rather than "this is correctly a non-priced asset".
    const usd = isNft ? "n/a" : t.usd_value != null ? `$${Number(t.usd_value).toFixed(2)}` : "unavailable";
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
      amount: `${Number(s.amount_sold).toFixed(4)} -> ${Number(s.amount_bought).toFixed(4)}`,
      usd: "—",
    });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function buildPdf({ request, periodStart, periodEnd, blockRange, openingValuation, closingValuation, gas, flows, gameActivity, realizedPnlUsd, unrealizedPnlUsd, netPnlUsd, tokenMeta, transactionLines, priceCoverageDisclaimer, nftDisclaimer, ensName, realizedEventsInPeriod }) {
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
  line("On-chain inflows (USD)", flows.onChainIn.toFixed(2));
  line("On-chain outflows (USD)", flows.onChainOut.toFixed(2));
  line("CEX deposits (USD)", flows.cexIn.toFixed(2));
  line("CEX withdrawals (USD)", flows.cexOut.toFixed(2));
  doc.moveDown(0.5);
  line("Gas fees paid (ETN)", gas.totalGasEtn);
  line("Gas fees paid (USD)", gas.totalGasUsd.toFixed(2));
  doc.moveDown(0.5);
  line("Realized P&L (USD)", realizedPnlUsd.toFixed(2));
  line("Unrealized P&L (USD)", unrealizedPnlUsd.toFixed(2));
  doc.moveDown(0.3);
  doc.fontSize(13).fillColor(THEME.white).font("Helvetica-Bold").text(`Net P&L after fees (USD): ${netPnlUsd.toFixed(2)}`);
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
    doc.fontSize(8);
    for (const e of realizedEventsInPeriod) {
      const gainLoss = e.realizedPnlUsd;
      const gainColor = gainLoss.isNegative() ? THEME.orange : THEME.green;
      const dateStr = e.timestamp.toISOString().slice(0, 10);
      const qtyStr = isNftAssetKey(e.tokenAddress) ? String(e.quantityConsumed) : e.quantityConsumed.toFixed(6);
      doc.fillColor(THEME.bodyText).text(
        `${dateStr}  ${qtyStr} ${formatAssetLabel(e.tokenAddress, tokenMeta)}  —  cost $${e.costBasisUsd.toFixed(2)}, proceeds $${e.proceedsUsd.toFixed(2)}  —  `,
        { continued: true }
      );
      doc.fillColor(gainColor).text(`${gainLoss.isNegative() ? "" : "+"}$${gainLoss.toFixed(2)}`);
    }
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
      doc.fillColor(THEME.bodyText).text(`${name} — Wagered: $${g.wageredUsd.toFixed(2)}, Won: $${g.wonUsd.toFixed(2)}, `, { continued: true });
      doc.fillColor(netColor).text(`Net: ${net.isNegative() ? "" : "+"}$${net.toFixed(2)}`, { continued: unpricedNote.length > 0 });
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

  const [transfers, swaps] = await Promise.all([
    getAllTransfersBefore(request.tracked_wallet, periodEnd),
    getAllSwapTradesBefore(request.tracked_wallet, periodEnd),
  ]);

  // NFT legs are pulled out and turned into their own mint/purchase/sale FIFO events (see
  // buildNftEvents) BEFORE the generic transferToEvent mapping runs, so consumedRowIds excludes
  // them there — an NFT leg must never be fed into FIFO both as a generic zero-priced transfer AND
  // as a properly cost-tracked NFT event.
  const { events: nftEvents, consumedRowIds: nftConsumedRowIds, unmatchedCount: nftUnmatchedCount } = buildNftEvents(transfers);
  const events = [
    ...transfers.filter((t) => !nftConsumedRowIds.has(t.id)).map(transferToEvent),
    ...swaps.map(swapToEvent),
    ...nftEvents,
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

  const [gas, closingValuation, openingValuation] = await Promise.all([
    computeGasFeesUsd(transfersInPeriod),
    valueInventoryAtTimestamp(closing.lots, periodEnd),
    valueInventoryAtTimestamp(opening.lots, periodStart),
  ]);
  const flows = summarizeFlows(transfersInPeriod, swapsInPeriod);
  const gameActivity = buildGameActivitySummary(transfersInPeriod);

  const realizedEventsInPeriod = closing.realizedEvents.filter((e) => e.timestamp >= periodStart);
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
  const transactionLines = buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta);
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

  const pdfBuffer = await buildPdf({ request, periodStart, periodEnd, blockRange, openingValuation, closingValuation, gas, flows, gameActivity, realizedPnlUsd, unrealizedPnlUsd: closingValuation.totalUnrealizedUsd, netPnlUsd, tokenMeta, transactionLines, priceCoverageDisclaimer, nftDisclaimer, ensName, realizedEventsInPeriod });

  const baseKey = `pnl-statements/${request.tracked_wallet.toLowerCase()}/${request.id}`;
  const jsonKey = `${baseKey}.json`;
  const pdfKey = `${baseKey}.pdf`;

  await Promise.all([
    uploadStatementArtifact(JSON.stringify(jsonArtifact, null, 2), jsonKey, "application/json"),
    uploadStatementArtifact(pdfBuffer, pdfKey, "application/pdf"),
  ]);

  const updated = await markGenerated(requestId, { artifactPdfKey: pdfKey, artifactJsonKey: jsonKey });
  console.log(`📄 Statement generated for request ${requestId} (wallet ${request.tracked_wallet}, net P&L $${netPnlUsd.toFixed(2)})`);
  return updated;
}
