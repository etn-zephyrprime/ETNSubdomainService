// backend/utils/pnlStatementRouter.js
//
// HTTP surface for the PnL statement feature — tx-hash/request-ID based access, no login (see the
// build plan's confirmed decision on this). Mounted at /api/pnl in backend/index.js.
//
// One exception: GET /pnl/statements (list-by-wallet, below) requires a signed proof of wallet
// ownership (see walletAuth.js) — everything else here is keyed by something you have to already
// possess (a request ID or tx hash), but that one was keyed on nothing but a public wallet
// address, which isn't a secret at all. See that route's own comment for the full reasoning.
import express from "express";
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getById, getByTxHash, getByPayerWallet, getCumulativeGeneratedSeries, markPendingGeneration, markViewedAndFinalize, markRefunded } from "../db/statementRequests.js";
import { getTotalCoreBurned } from "../db/buyAndBurnLog.js";
import { generateStatement } from "../services/pnlStatementGenerator.js";
import { periodTypeLabel } from "../services/periodTypes.js";
import { verifyWalletOwnership } from "./walletAuth.js";

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
    periodType: r.period_type,
    periodTypeLabel: periodTypeLabel(r.period_type),
    year: r.year,
    trackedWallet: r.tracked_wallet,
    payerWallet: r.payer_wallet,
    amountPaidWei: r.amount_paid_wei,
    status: r.status,
    selfOwnedAddresses: r.self_owned_addresses,
    createdAt: r.created_at,
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

// Powers the "N of M ready" progress tracker on the PnL Statement tab — a wallet's full order
// history, oldest first, so a returning visitor (or one who just closed the tab mid-generation)
// can still see where things stand without needing the original tx hash or request IDs.
//
// Unlike the rest of this router, this one DOES require proof of wallet ownership (see
// walletAuth.js). Every other endpoint here is keyed by a request ID or tx hash — something you
// have to already have been given or have paid for yourself, an intentional "anyone with the
// link can view" design. This endpoint took a bare `payerWallet` and hands back that wallet's
// entire order history keyed on nothing but the address itself — always public, so with no auth
// this was a one-call way to list anyone's statement history knowing only their wallet address,
// no link or tx hash needed at all. Confirmed and fixed 2026-09-04.
router.get("/pnl/statements", async (req, res) => {
  const { payerWallet, signature, timestamp } = req.query;
  if (!payerWallet || !ethers.isAddress(payerWallet)) {
    return res.status(400).json({ error: "Query param payerWallet must be a valid address" });
  }

  try {
    verifyWalletOwnership(payerWallet, signature, timestamp);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const requests = await getByPayerWallet(payerWallet);
  res.json(requests.map(serializeRequest));
});

// Site-wide, non-sensitive aggregates for the PnL Statements tab's "CORE Burned" card and
// cumulative "Statements Generated" chart — no auth needed (same posture as GET /games-style
// endpoints elsewhere in this codebase): nothing here is keyed to any one wallet or request.
router.get("/pnl/stats", async (req, res) => {
  const [totalCoreBurned, cumulativeGenerated] = await Promise.all([
    getTotalCoreBurned(),
    getCumulativeGeneratedSeries(),
  ]);
  res.json({ totalCoreBurned, cumulativeGenerated });
});

// Fills in the user-supplied self-owned-addresses list (watcher already created the row, fully
// knowing period_type/year, from the confirmed on-chain purchase event — see
// premiumSubscriptionWatcher.js) and kicks off generation. Generation runs in the background — a
// wallet's first-ever request can mean ingesting years of history, which is exactly why
// PENDING_GENERATION exists as a distinct status the client polls rather than something this
// endpoint blocks a response on.
router.post("/pnl/statement/:requestId/request", async (req, res) => {
  const { selfOwnedAddresses } = req.body || {};
  if (selfOwnedAddresses && !Array.isArray(selfOwnedAddresses)) {
    return res.status(400).json({ error: "selfOwnedAddresses must be an array" });
  }
  for (const addr of selfOwnedAddresses || []) {
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: `Invalid address in selfOwnedAddresses: ${addr}` });
  }

  const updated = await markPendingGeneration(req.params.requestId, { selfOwnedAddresses });
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
  // BACKEND_PRIVATE_KEY, not CORE_CLASH_BACKEND_PRIVATE_KEY — PremiumSubscription's operator is a
  // deliberately separate key from the Core Clash drip bot's (see pnlSplitExecutionScheduler.js's
  // header comment for the same confirmed design choice).
  if (!process.env.BACKEND_PRIVATE_KEY || !PREMIUM_SUBSCRIPTION_ADDRESS) {
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
    const wallet = new ethers.Wallet(process.env.BACKEND_PRIVATE_KEY, provider);
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
