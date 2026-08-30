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
import { getById, markGenerated } from "../db/statementRequests.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { ingestWalletHistory } from "./pnlIngestion.js";
import { replayFifo } from "./fifoLotEngine.js";
import { getHistoricalPriceUsd } from "./pnlPricing.js";

const NATIVE_SENTINEL = "NATIVE";
const DISCLAIMER =
  "This statement is provided for informational purposes only and does not constitute tax, " +
  "legal, or financial advice. Figures use FIFO cost-basis accounting and the fiscal year-end " +
  "date you selected, which may not match every jurisdiction's actual tax treatment. Consult a " +
  "qualified professional in your jurisdiction before relying on this statement for tax filing.";

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

/** Rolling-forward period window: period_index 0 ends at yearEndMarkDate, each subsequent
 * pre-purchased period rolls one year later — matches the brief's "anchor for this and all
 * subsequent periods." */
function periodWindow(yearEndMarkDate, periodIndex) {
  const end = new Date(yearEndMarkDate);
  end.setUTCFullYear(end.getUTCFullYear() + periodIndex);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  return { periodStart: start, periodEnd: end };
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

function buildPdf({ request, periodStart, periodEnd, opening, closing, gas, flows, realizedPnlUsd, unrealizedPnlUsd, netPnlUsd }) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  doc.fontSize(18).text("Profit & Loss Statement", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#555").text("Planet Zephyros — Electroneum Dashboard", { align: "center" });
  doc.moveDown(1.5);

  doc.fillColor("#000").fontSize(11);
  doc.text(`Wallet: ${request.tracked_wallet}`);
  doc.text(`Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
  doc.text(`Request ID: ${request.id}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.moveDown(1);

  const line = (label, value) => doc.fontSize(11).text(`${label}: ${value}`);

  doc.fontSize(14).text("Summary", { underline: true });
  doc.moveDown(0.3);
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
  doc.fontSize(12).text(`Net P&L after fees (USD): ${netPnlUsd.toFixed(2)}`, { underline: true });
  doc.moveDown(1);

  doc.fontSize(14).text("Closing Inventory", { underline: true });
  doc.moveDown(0.3);
  if (closing.lots.length === 0) {
    doc.fontSize(10).text("No open positions at period end.");
  } else {
    const byToken = new Map();
    for (const lot of closing.lots) {
      const key = lot.tokenAddress;
      const cur = byToken.get(key) || new Decimal(0);
      byToken.set(key, cur.plus(lot.quantityRemaining));
    }
    for (const [token, qty] of byToken) {
      doc.fontSize(10).text(`${token === NATIVE_SENTINEL ? "ETN" : token}: ${qty.toFixed(6)}`);
    }
  }
  doc.moveDown(1);

  doc.fontSize(8).fillColor("#777").text(DISCLAIMER, { align: "left" });

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

  const { periodStart, periodEnd } = periodWindow(request.year_end_mark_date, request.period_index);
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

  const [gas, unrealized] = await Promise.all([
    computeGasFeesUsd(transfersInPeriod),
    computeUnrealizedPnl(closing.lots, periodEnd),
  ]);
  const flows = summarizeFlows(transfersInPeriod);

  const realizedPnlUsd = closing.realizedEvents
    .filter((e) => e.timestamp >= periodStart)
    .reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  const netPnlUsd = realizedPnlUsd.plus(unrealized.totalUnrealizedUsd).minus(gas.totalGasUsd);

  const jsonArtifact = {
    schemaVersion: 1,
    requestId: request.id,
    trackedWallet: request.tracked_wallet,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    generatedAt: new Date().toISOString(),
    openingInventory: opening.lots.map((l) => ({ tokenAddress: l.tokenAddress, quantity: l.quantityRemaining.toString(), unitCostUsd: l.unitCostUsd.toString() })),
    closingInventory: closing.lots.map((l) => ({ tokenAddress: l.tokenAddress, quantity: l.quantityRemaining.toString(), unitCostUsd: l.unitCostUsd.toString() })),
    flows: { onChainIn: flows.onChainIn.toString(), onChainOut: flows.onChainOut.toString(), cexIn: flows.cexIn.toString(), cexOut: flows.cexOut.toString() },
    fees: { gasEtn: gas.totalGasEtn, gasUsd: gas.totalGasUsd.toString() },
    realizedPnlEvents: closing.realizedEvents.filter((e) => e.timestamp >= periodStart).map((e) => ({
      tokenAddress: e.tokenAddress,
      disposalTxHash: e.disposalTxHash,
      timestamp: e.timestamp.toISOString(),
      quantityConsumed: e.quantityConsumed.toString(),
      costBasisUsd: e.costBasisUsd.toString(),
      proceedsUsd: e.proceedsUsd.toString(),
      realizedPnlUsd: e.realizedPnlUsd.toString(),
    })),
    unrealizedPnl: { totalUsd: unrealized.totalUnrealizedUsd.toString(), perToken: unrealized.perToken },
    summary: { realizedPnlUsd: realizedPnlUsd.toString(), unrealizedPnlUsd: unrealized.totalUnrealizedUsd.toString(), netPnlAfterFeesUsd: netPnlUsd.toString() },
    disclaimer: DISCLAIMER,
  };

  const pdfBuffer = await buildPdf({ request, periodStart, periodEnd, opening, closing, gas, flows, realizedPnlUsd, unrealizedPnlUsd: unrealized.totalUnrealizedUsd, netPnlUsd });

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
