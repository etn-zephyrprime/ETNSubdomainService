// Argus "Contract Check" API (services/contractCheck/).
//
//   GET  /api/contract-check/:target     facts for an address or name.etn — Core tier, wallet-signed (query
//                                        params). Free users only get the overall badge, for ElectroSwap-listed
//                                        tokens, from the static contract-badges.json (services/contractCheck/badges.js)
//   POST /api/contract-check/explain     Core tier, wallet-signed: { wallet, signature, timestamp, address,
//                                        question? } -> the cached summary, or an answer to `question`
//                                        (5 a day, 20 a week, 50 a month per member: questionQuota.js); both
//                                        carry `questions` = what's left
//
// Rate limits per IP (and per wallet on explain). Analysing an uncached contract costs explorer + RPC calls,
// and a question costs a Claude call, so both are bounded.
import express from "express";
import { ethers } from "ethers";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { explainContract, answerQuestion } from "../services/contractCheck/explain.js";
import { DISCLAIMER } from "../services/contractCheck/prompts.js";
import { getQuestionUsage, incrementQuestionCount } from "../db/contractCheckAi.js";
import { periodStarts, quotaStatus } from "../services/contractCheck/questionQuota.js";
import { resolveEtnName } from "./primaryNameResolver.js";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { createRateLimiter, clientIp } from "./rateLimit.js";
import { usedContracts, activeApprovals, searchContracts } from "../services/contractCheck/lists.js";
import { getCoveredWallets } from "../db/trackedWallets.js";

const router = express.Router();
const AUTH_PURPOSE = "Premium Dashboard"; // same signed message as the other Core tier routes

const factsByIp = createRateLimiter({ max: Number(process.env.CONTRACT_CHECK_FACTS_PER_10MIN) || 30, windowMs: 10 * 60 * 1000 });
const explainByIp = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const explainByWallet = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000 });

const today = () => new Date().toISOString().slice(0, 10);

function limited(res, r) {
  res.set("Retry-After", String(r.retryAfterSec));
  res.status(429).json({ error: `Too many requests — try again in ${r.retryAfterSec}s` });
}

/** An address, or a name.etn resolved to one; null if neither. */
async function resolveTarget(target) {
  const t = String(target || "").trim();
  if (ethers.isAddress(t)) return ethers.getAddress(t);
  if (t.toLowerCase().endsWith(".etn")) return resolveEtnName(contractCheckProvider(), t);
  return null;
}

const searchByIp = createRateLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
const listsByWallet = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
const searchByWallet = createRateLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
const factsByWallet = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

/** Wallet signature + Core tier for the GET routes (query params). Sends the error and returns false on failure. */
async function requireCore(req, res, limiter = listsByWallet) {
  const { wallet, signature, timestamp } = req.query;
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
  const r = limiter(`core:${String(wallet).toLowerCase()}`);
  if (!r.ok) {
    limited(res, r);
    return false;
  }
  if (!(await hasCoreAccess(wallet))) {
    res.status(403).json({ error: "Core tier membership required" });
    return false;
  }
  return true;
}

// Search suggestions: symbol / project / name.etn / address.
router.get("/contract-check/search", async (req, res) => {
  const r = searchByIp(`search:${clientIp(req)}`);
  if (!r.ok) return limited(res, r);
  if (!(await requireCore(req, res, searchByWallet))) return;
  try {
    res.json({ results: await searchContracts(req.query.q) });
  } catch (err) {
    console.error("⚠️  Contract Check: search failed:", err.message);
    res.status(502).json({ error: "Search isn't available right now" });
  }
});

// "Contracts you've used" — across the member's own and tracked wallets.
router.get("/contract-check/used", async (req, res) => {
  if (!(await requireCore(req, res))) return;
  try {
    res.json({ contracts: await usedContracts(req.query.wallet) });
  } catch (err) {
    console.error("⚠️  Contract Check: used-contracts failed:", err.message);
    res.status(502).json({ error: "Couldn't load your contracts right now — try again shortly" });
  }
});

// The connected wallet's live approvals (only it can revoke them, so only its own).
// `owner` (optional) = one of the member's covered wallets (their own or a tracked one); default their own.
// Revoking still needs that wallet's own signature — the frontend hands it off (CoreTierContracts.jsx).
router.get("/contract-check/approvals", async (req, res) => {
  if (!(await requireCore(req, res))) return;
  let owner = req.query.wallet;
  if (req.query.owner) {
    if (!ethers.isAddress(req.query.owner)) return res.status(400).json({ error: "Invalid wallet" });
    const covered = (await getCoveredWallets(req.query.wallet)).map((w) => w.address.toLowerCase());
    if (!covered.includes(req.query.owner.toLowerCase())) return res.status(403).json({ error: "That wallet isn't one of your tracked wallets" });
    owner = req.query.owner;
  }
  try {
    res.json(await activeApprovals(owner, { force: req.query.refresh === "1" }));
  } catch (err) {
    console.error("⚠️  Contract Check: approvals failed:", err.message);
    res.status(502).json({ error: "Couldn't load your approvals right now — try again shortly" });
  }
});

router.get("/contract-check/:target", async (req, res) => {
  const r = factsByIp(`facts:${clientIp(req)}`);
  if (!r.ok) return limited(res, r);
  if (!(await requireCore(req, res, factsByWallet))) return;
  const address = await resolveTarget(req.params.target);
  if (!address) return res.status(400).json({ error: "Give a contract address or a name.etn that resolves to one" });
  try {
    const facts = await analyseContract(address);
    res.json({ facts, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error(`⚠️  Contract Check: analysis failed for ${address}:`, err.message);
    res.status(502).json({ error: "Couldn't analyse that contract right now — try again shortly" });
  }
});

router.post("/contract-check/explain", express.json({ limit: "8kb" }), async (req, res) => {
  const { wallet, signature, timestamp, address: target, question } = req.body || {};
  const ipR = explainByIp(`explain:${clientIp(req)}`);
  if (!ipR.ok) return limited(res, ipR);
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const wR = explainByWallet(`explain:${wallet.toLowerCase()}`);
  if (!wR.ok) return limited(res, wR);
  if (!(await hasCoreAccess(wallet))) return res.status(403).json({ error: "Core tier membership required" });

  const address = await resolveTarget(target);
  if (!address) return res.status(400).json({ error: "Give a contract address or a name.etn that resolves to one" });
  try {
    const facts = await analyseContract(address);
    const used = await getQuestionUsage(wallet, periodStarts());
    if (!question) return res.json({ ...(await explainContract(facts)), questions: quotaStatus(used) });

    if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "Question must be text" });
    const before = quotaStatus(used);
    if (before.remaining === 0) return res.status(429).json({ error: before.message, remaining: 0, questions: before });
    const answer = await answerQuestion(facts, question, { wallet });
    await incrementQuestionCount(wallet, today());
    const after = quotaStatus({ day: used.day + 1, week: used.week + 1, month: used.month + 1 });
    res.json({ ...answer, remaining: after.remaining, questions: after });
  } catch (err) {
    console.error(`⚠️  Contract Check: explain failed for ${address}:`, err.message);
    res.status(502).json({ error: "Couldn't explain that contract right now — try again shortly" });
  }
});

export default router;
