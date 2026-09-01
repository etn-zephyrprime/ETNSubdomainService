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
import { ingestWalletHistory, getBlockByTimestamp, getTokenMetadata } from "./pnlIngestion.js";
import { replayFifo } from "./fifoLotEngine.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";
import { computePeriodBoundaries, periodTypeLabel } from "./periodTypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Planet Zephyros brand palette — kept in exact sync with src/dashboard/theme.js by hand (this
// backend has no build step that could import that frontend file directly). If the dashboard's
// palette ever changes, update both.
const THEME = {
  background: "#081c0a",
  green: "#18bb1a",
  white: "#ffffff",
  bodyText: "#e5e5e5", // slightly softer than pure white for dense paragraph/detail text
  muted: "#9a9a9a", // theme.js's mutedLight
  border: "#333333",
};
const LOGO_PATH = path.resolve(__dirname, "..", "assets", "PlanetZephyrosLogo.png");
const WORDMARK_PATH = path.resolve(__dirname, "..", "assets", "PlanetZephyrosText.png");
const ORBITRON_BOLD_PATH = path.resolve(__dirname, "..", "fonts", "Orbitron-Bold.ttf");

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
  ["On-chain inflows / outflows (USD)", "The USD value of ETN and tokens received or sent on-chain during this period, excluding transfers between your own addresses (see \"self-owned addresses\") and gas fees, which are broken out separately below."],
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

/** "Name (SYMBOL) (0xAddress)" when both name/symbol are known, degrading gracefully down to just
 * the address if metadata lookup failed for that token. Native ETN has no contract address, so it
 * never gets a trailing "(0x...)" segment. `tokenMeta` is the Map built by collectTokenMetadata. */
function formatAssetLabel(tokenAddress, tokenMeta) {
  if (tokenAddress === NATIVE_SENTINEL) return "Electroneum (ETN)";
  const meta = tokenMeta.get(tokenAddress.toLowerCase());
  if (meta?.name && meta?.symbol) return `${meta.name} (${meta.symbol}) (${tokenAddress})`;
  if (meta?.symbol) return `${meta.symbol} (${tokenAddress})`;
  return tokenAddress;
}

/** Resolves and caches name/symbol for every distinct token address appearing anywhere in this
 * statement (opening/closing inventory, unrealized holdings, realized disposal events, plus every
 * in-period transfer/swap for the Transaction History section) in one pass, so
 * formatAssetLabel/JSON enrichment never has to do it ad hoc per line item. Native ETN is never
 * looked up (formatAssetLabel special-cases it directly). */
async function collectTokenMetadata(openingLots, closingLots, unrealizedPerToken, realizedEvents, transfersInPeriod, swapsInPeriod) {
  const addresses = new Set();
  for (const l of openingLots) if (l.tokenAddress !== NATIVE_SENTINEL) addresses.add(l.tokenAddress.toLowerCase());
  for (const l of closingLots) if (l.tokenAddress !== NATIVE_SENTINEL) addresses.add(l.tokenAddress.toLowerCase());
  for (const t of unrealizedPerToken) if (t.tokenAddress !== NATIVE_SENTINEL) addresses.add(t.tokenAddress.toLowerCase());
  for (const e of realizedEvents) if (e.tokenAddress !== NATIVE_SENTINEL) addresses.add(e.tokenAddress.toLowerCase());
  for (const t of transfersInPeriod) if (t.token_address) addresses.add(t.token_address.toLowerCase());
  for (const s of swapsInPeriod) {
    if (s.token_sold_address && s.token_sold_address !== NATIVE_SENTINEL) addresses.add(s.token_sold_address.toLowerCase());
    if (s.token_bought_address && s.token_bought_address !== NATIVE_SENTINEL) addresses.add(s.token_bought_address.toLowerCase());
  }

  const tokenMeta = new Map();
  await Promise.all(
    [...addresses].map(async (addr) => {
      const meta = await getTokenMetadata(addr);
      if (meta) tokenMeta.set(addr, meta);
    })
  );
  return tokenMeta;
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

function summarizeFlows(transfersInPeriod) {
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
  return summary;
}

async function computeUnrealizedPnl(closingLots, periodEnd) {
  const byToken = new Map();
  for (const lot of closingLots) {
    if (!byToken.has(lot.tokenAddress)) byToken.set(lot.tokenAddress, []);
    byToken.get(lot.tokenAddress).push(lot);
  }

  let totalUnrealizedUsd = new Decimal(0);
  const perToken = [];
  for (const [tokenAddress, lots] of byToken) {
    const quantity = lots.reduce((sum, l) => sum.plus(l.quantityRemaining), new Decimal(0));
    const costBasis = lots.reduce((sum, l) => sum.plus(l.quantityRemaining.times(l.unitCostUsd)), new Decimal(0));
    let marketValue = null;
    try {
      const priceUsd = await getHistoricalPriceUsd(tokenAddress, periodEnd);
      marketValue = quantity.times(priceUsd);
      totalUnrealizedUsd = totalUnrealizedUsd.plus(marketValue.minus(costBasis));
    } catch (err) {
      console.warn(`⚠️  Statement generator: could not mark ${tokenAddress} to market at period end:`, err.message);
    }
    perToken.push({ tokenAddress, quantity: quantity.toString(), costBasisUsd: costBasis.toString(), marketValueUsd: marketValue?.toString() ?? null });
  }
  return { totalUnrealizedUsd, perToken };
}

/** Sums lot quantities per token and renders one line per distinct asset, using formatAssetLabel
 * for the "Name (SYMBOL) (0xAddress)" formatting — shared by both the Opening and Closing
 * Inventory sections below, which are otherwise identical in shape. */
function renderInventorySection(doc, lots, tokenMeta, emptyText) {
  if (lots.length === 0) {
    doc.fontSize(10).fillColor(THEME.muted).text(emptyText);
    return;
  }
  const byToken = new Map();
  for (const lot of lots) {
    const key = lot.tokenAddress;
    const cur = byToken.get(key) || new Decimal(0);
    byToken.set(key, cur.plus(lot.quantityRemaining));
  }
  for (const [token, qty] of byToken) {
    doc.fontSize(10).fillColor(THEME.bodyText).text(`${formatAssetLabel(token, tokenMeta)}: ${qty.toFixed(6)}`);
  }
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—";
}

/** Builds the chronological, page-spanning transaction list — every in-period transfer (native +
 * token, excluding pure gas-fee bookkeeping rows, which have no asset movement of their own and
 * are already totaled in the Fees summary) plus every in-period swap, sorted oldest first. This is
 * the literal ledger a statement's "Transaction History" section shows — separate from
 * realizedPnlEvents (FIFO disposals only) and from the flows/gas totals (aggregated, not
 * itemized). */
function buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta) {
  const items = [];
  for (const t of transfersInPeriod) {
    if (t.gas_fee_wei != null || Number(t.amount_raw) === 0) continue;
    const tag = t.is_self_transfer ? " (self)" : t.is_cex ? " (CEX)" : "";
    const usd = t.usd_value != null ? `$${Number(t.usd_value).toFixed(2)}` : "price unavailable";
    items.push({
      timestamp: new Date(t.timestamp),
      text: `${t.direction === "in" ? "IN " : "OUT"}${tag}  ${Number(t.amount_decimal).toFixed(6)} ${formatAssetLabel(t.token_address || NATIVE_SENTINEL, tokenMeta)}  —  ${usd}  —  tx ${shortHash(t.tx_hash)}`,
    });
  }
  for (const s of swapsInPeriod) {
    items.push({
      timestamp: new Date(s.timestamp),
      text: `SWAP  ${Number(s.amount_sold).toFixed(6)} ${formatAssetLabel(s.token_sold_address, tokenMeta)}  ->  ${Number(s.amount_bought).toFixed(6)} ${formatAssetLabel(s.token_bought_address, tokenMeta)}  —  tx ${shortHash(s.tx_hash)}`,
    });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function buildPdf({ request, periodStart, periodEnd, blockRange, opening, closing, gas, flows, realizedPnlUsd, unrealizedPnlUsd, netPnlUsd, tokenMeta, transactionLines }) {
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
  // transaction history below can easily run to several pages for an active wallet) — pageAdded
  // fires after the new page exists but before anything's drawn on it, and .rect().fill() changes
  // the current fill color as a side effect, so every draw call below re-sets its own color rather
  // than assuming what the background fill left behind.
  const paintBackground = () => doc.rect(0, 0, doc.page.width, doc.page.height).fill(THEME.background);
  paintBackground();
  doc.on("pageAdded", paintBackground);

  const sectionHeader = (text) => {
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(THEME.green).font("Helvetica-Bold").text(text);
    doc.moveDown(0.3);
  };

  // Header: logo + wordmark side by side, matching DashboardHeader.jsx's own layout.
  const logoHeight = 46;
  const logoY = doc.y;
  try {
    doc.image(LOGO_PATH, doc.page.width / 2 - 140, logoY, { height: logoHeight });
    doc.image(WORDMARK_PATH, doc.page.width / 2 - 80, logoY + 8, { height: 30 });
  } catch (err) {
    console.warn("⚠️  Statement PDF: could not embed logo/wordmark images:", err.message);
  }
  doc.y = logoY + logoHeight + 16;

  doc.font(hasOrbitron ? "Orbitron-Bold" : "Helvetica-Bold").fontSize(18).fillColor(THEME.white)
    .text("Profit & Loss Statement", { align: "center" });
  doc.font("Helvetica");
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor(THEME.muted).text("Planet Zephyros — Electroneum Dashboard", { align: "center" });
  doc.moveDown(1.3);

  doc.fillColor(THEME.bodyText).fontSize(11);
  doc.text(`Wallet: ${request.tracked_wallet}`);
  doc.text(`Reporting period: ${periodTypeLabel(request.period_type)} ${request.year}`);
  doc.text(`Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
  if (blockRange) {
    doc.fillColor(THEME.muted).text(`Block range: ${blockRange.startBlock} to ${blockRange.endBlock} (for cross-checking against the block explorer — see the explanation below)`);
    doc.fillColor(THEME.bodyText);
  }
  doc.text(`Request ID: ${request.id}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.moveDown(1);

  const line = (label, value) => doc.fontSize(11).fillColor(THEME.bodyText).text(`${label}: ${value}`);

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

  sectionHeader("Opening Inventory");
  renderInventorySection(doc, opening.lots, tokenMeta, "No open positions at period start (this appears to be the wallet's first reporting period).");
  doc.moveDown(1);

  sectionHeader("Closing Inventory");
  renderInventorySection(doc, closing.lots, tokenMeta, "No open positions at period end.");
  doc.moveDown(1);

  sectionHeader("Transaction History");
  if (transactionLines.length === 0) {
    doc.fontSize(10).fillColor(THEME.muted).text("No transactions in this period.");
  } else {
    doc.fontSize(8).fillColor(THEME.bodyText);
    for (const item of transactionLines) {
      doc.text(`${item.timestamp.toISOString().slice(0, 16).replace("T", " ")}  ${item.text}`);
    }
  }
  doc.moveDown(1);

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
  doc.moveDown(0.6);

  doc.fontSize(8).fillColor(THEME.muted).text(DISCLAIMER, { align: "left" });

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

  const selfOwnedAddresses = Array.isArray(request.self_owned_addresses) ? request.self_owned_addresses : [];
  await ingestWalletHistory(request.tracked_wallet, selfOwnedAddresses);

  const [transfers, swaps] = await Promise.all([
    getAllTransfersBefore(request.tracked_wallet, periodEnd),
    getAllSwapTradesBefore(request.tracked_wallet, periodEnd),
  ]);

  const events = [...transfers.map(transferToEvent), ...swaps.map(swapToEvent)].sort((a, b) => a.timestamp - b.timestamp);
  const { opening, closing } = replayFifo(events, periodStart, periodEnd);

  const transfersInPeriod = transfers.filter((t) => {
    const ts = new Date(t.timestamp);
    return ts >= periodStart && ts < periodEnd;
  });
  const swapsInPeriod = swaps.filter((s) => {
    const ts = new Date(s.timestamp);
    return ts >= periodStart && ts < periodEnd;
  });

  const [gas, unrealized] = await Promise.all([
    computeGasFeesUsd(transfersInPeriod),
    computeUnrealizedPnl(closing.lots, periodEnd),
  ]);
  const flows = summarizeFlows(transfersInPeriod);

  const realizedEventsInPeriod = closing.realizedEvents.filter((e) => e.timestamp >= periodStart);
  const realizedPnlUsd = realizedEventsInPeriod.reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  const netPnlUsd = realizedPnlUsd.plus(unrealized.totalUnrealizedUsd).minus(gas.totalGasUsd);

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

  const tokenMeta = await collectTokenMetadata(opening.lots, closing.lots, unrealized.perToken, realizedEventsInPeriod, transfersInPeriod, swapsInPeriod);
  const withAssetLabel = (obj, tokenAddress) => ({ ...obj, tokenAddress, assetLabel: formatAssetLabel(tokenAddress, tokenMeta) });
  const transactionLines = buildTransactionLines(transfersInPeriod, swapsInPeriod, tokenMeta);

  const jsonArtifact = {
    schemaVersion: 1,
    requestId: request.id,
    trackedWallet: request.tracked_wallet,
    periodType: request.period_type,
    periodTypeLabel: periodTypeLabel(request.period_type),
    year: request.year,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    blockRange,
    generatedAt: new Date().toISOString(),
    openingInventory: opening.lots.map((l) => withAssetLabel({ quantity: l.quantityRemaining.toString(), unitCostUsd: l.unitCostUsd.toString() }, l.tokenAddress)),
    closingInventory: closing.lots.map((l) => withAssetLabel({ quantity: l.quantityRemaining.toString(), unitCostUsd: l.unitCostUsd.toString() }, l.tokenAddress)),
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
      totalUsd: unrealized.totalUnrealizedUsd.toString(),
      perToken: unrealized.perToken.map((t) => withAssetLabel(t, t.tokenAddress)),
    },
    // Every in-period transfer/swap, chronological — the same ledger the PDF's Transaction History
    // pages show (see buildTransactionLines), just machine-readable here instead of pre-formatted.
    transactions: transactionLines.map((item) => ({ timestamp: item.timestamp.toISOString(), description: item.text })),
    summary: { realizedPnlUsd: realizedPnlUsd.toString(), unrealizedPnlUsd: unrealized.totalUnrealizedUsd.toString(), netPnlAfterFeesUsd: netPnlUsd.toString() },
    summaryExplanations: Object.fromEntries(SUMMARY_EXPLANATIONS),
    disclaimer: DISCLAIMER,
  };

  const pdfBuffer = await buildPdf({ request, periodStart, periodEnd, blockRange, opening, closing, gas, flows, realizedPnlUsd, unrealizedPnlUsd: unrealized.totalUnrealizedUsd, netPnlUsd, tokenMeta, transactionLines });

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
