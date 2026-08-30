// backend/utils/pnlStatementRouter.js
//
// HTTP surface for the PnL statement feature — tx-hash/request-ID based access, no login (see the
// build plan's confirmed decision on this). Mounted at /api/pnl in backend/index.js.
import express from "express";
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getById, getByTxHash, markPendingGeneration, markViewedAndFinalize, markRefunded } from "../db/statementRequests.js";
import { generateStatement } from "../services/pnlStatementGenerator.js";

const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const REFUND_GAS_LIMIT = process.env.PNL_REFUND_GAS_LIMIT ? parseInt(process.env.PNL_REFUND_GAS_LIMIT, 10) : 150000;

const PREMIUM_SUBSCRIPTION_ABI = [
  "function refundPnlPeriod(address to, uint256 amount) external",
];

function artifactUrl(key) {
  if (!key || !R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

function serializeRequest(r) {
  return {
    id: r.id,
    txHash: r.tx_hash,
    periodIndex: r.period_index,
    trackedWallet: r.tracked_wallet,
    payerWallet: r.payer_wallet,
    amountPaidWei: r.amount_paid_wei,
    status: r.status,
    yearEndMarkDate: r.year_end_mark_date,
    selfOwnedAddresses: r.self_owned_addresses,
    generatedAt: r.generated_at,
    firstViewedAt: r.first_viewed_at,
    finalizedAt: r.finalized_at,
    refundedAt: r.refunded_at,
    pdfUrl: artifactUrl(r.artifact_pdf_key),
    jsonUrl: artifactUrl(r.artifact_json_key),
  };
}

const router = express.Router();

router.get("/pnl/statement/:requestId", async (req, res) => {
  const request = await getById(req.params.requestId);
  if (!request) return res.status(404).json({ error: "Statement request not found" });
  res.json(serializeRequest(request));
});

router.get("/pnl/statement/by-tx/:txHash", async (req, res) => {
  const requests = await getByTxHash(req.params.txHash);
  res.json(requests.map(serializeRequest));
});

// Fills in the user-supplied period metadata (watcher already created the row from the confirmed
// on-chain purchase event — see premiumSubscriptionWatcher.js) and kicks off generation.
// Generation runs in the background — a wallet's first-ever request can mean ingesting years of
// history, which is exactly why PENDING_GENERATION exists as a distinct status the client polls
// rather than something this endpoint blocks a response on.
router.post("/pnl/statement/:requestId/request", async (req, res) => {
  const { yearEndMarkDate, selfOwnedAddresses } = req.body || {};
  if (!yearEndMarkDate) return res.status(400).json({ error: "yearEndMarkDate is required" });
  if (selfOwnedAddresses && !Array.isArray(selfOwnedAddresses)) {
    return res.status(400).json({ error: "selfOwnedAddresses must be an array" });
  }
  for (const addr of selfOwnedAddresses || []) {
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: `Invalid address in selfOwnedAddresses: ${addr}` });
  }

  const updated = await markPendingGeneration(req.params.requestId, { yearEndMarkDate, selfOwnedAddresses });
  if (!updated) {
    return res.status(409).json({ error: "Request not found, or not in PAID status (already requested?)" });
  }
  res.json(serializeRequest(updated));

  generateStatement(updated.id).catch((err) => {
    console.error(`❌ Statement generation failed for request ${updated.id}:`, err.message);
    // Left in PENDING_GENERATION — a retry (calling this same endpoint again isn't possible since
    // it's no longer PAID, so this needs either an admin retry path or the user should be shown a
    // "generation failed, contact support" state; flagged as a follow-up, not silently hidden).
  });
});

// The finalize-on-view trigger (see PremiumSubscription.sol's header comment on the two trigger
// paths — this is one of them, the 14-day auto-finalize cron is the other). Fired by the frontend
// via navigator.sendBeacon() when the artifact's actual byte fetch resolves, not on page mount —
// "the user actually received the content" is the brief's own definition of view/download.
router.post("/pnl/statement/:requestId/view", async (req, res) => {
  const updated = await markViewedAndFinalize(req.params.requestId);
  if (!updated) return res.status(404).json({ error: "Statement request not found" });
  res.json(serializeRequest(updated));
  // The actual buy-and-burn split executes asynchronously via pnlSplitExecutionScheduler.js,
  // which polls for newly-FINALIZED rows — not fired synchronously here, so this endpoint (called
  // via sendBeacon, which doesn't wait for or read a response body) stays fast and reliable.
});

router.post("/pnl/statement/:requestId/refund", async (req, res) => {
  if (!process.env.CORE_CLASH_BACKEND_PRIVATE_KEY || !PREMIUM_SUBSCRIPTION_ADDRESS) {
    return res.status(503).json({ error: "Refunds are not configured on this backend" });
  }

  const request = await getById(req.params.requestId);
  if (!request) return res.status(404).json({ error: "Statement request not found" });
  if (!["PAID", "PENDING_GENERATION", "GENERATED"].includes(request.status) || request.first_viewed_at) {
    return res.status(409).json({ error: `Request is ${request.status}${request.first_viewed_at ? " and already viewed" : ""} — not refundable` });
  }
  if (BigInt(request.amount_paid_wei) === 0n) {
    return res.status(409).json({ error: "This request had no payment (free member period) — nothing to refund" });
  }

  try {
    const provider = createRpcProvider();
    const wallet = new ethers.Wallet(process.env.CORE_CLASH_BACKEND_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PREMIUM_SUBSCRIPTION_ABI, wallet);

    const tx = await contract.refundPnlPeriod(request.payer_wallet, request.amount_paid_wei, { gasLimit: REFUND_GAS_LIMIT });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("refundPnlPeriod transaction failed");

    const updated = await markRefunded(request.id, tx.hash);
    if (!updated) {
      // Refund executed on-chain but the DB transition lost a race (e.g. concurrent finalize) —
      // surface this loudly rather than silently, since the ETN really did move.
      console.error(`❌ CRITICAL: refunded on-chain (tx ${tx.hash}) but statement_requests row ${request.id} could not be marked REFUNDED — needs manual reconciliation`);
      return res.status(500).json({ error: "Refund executed on-chain but status update failed — contact support", txHash: tx.hash });
    }
    res.json(serializeRequest(updated));
  } catch (err) {
    console.error(`❌ Refund failed for request ${request.id}:`, err.message);
    res.status(502).json({ error: "Refund transaction failed", detail: err.message });
  }
});

export default router;
