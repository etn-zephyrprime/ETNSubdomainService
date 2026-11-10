// Argus "Contract Check" API (services/contractCheck/).
//
//   GET  /api/contract-check/:target     facts for an address or name.etn — public: free users see the risk
//                                        flags and badge too (a high-severity warning is never paywalled)
//   POST /api/contract-check/explain     Core tier, wallet-signed: { wallet, signature, timestamp, address,
//                                        question? } -> the cached summary, or an answer to `question`
//                                        (CONTRACT_QA_DAILY_LIMIT per member per UTC day)
//
// Rate limits per IP (and per wallet on explain). Analysing an uncached contract costs explorer + RPC calls,
// and a question costs a Claude call, so both are bounded.
import express from "express";
import { ethers } from "ethers";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { explainContract, answerQuestion } from "../services/contractCheck/explain.js";
import { DISCLAIMER } from "../services/contractCheck/prompts.js";
import { getQuestionCount, incrementQuestionCount } from "../db/contractCheckAi.js";
import { resolveEtnName } from "./primaryNameResolver.js";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { createRateLimiter, clientIp } from "./rateLimit.js";

const router = express.Router();
const AUTH_PURPOSE = "Premium Dashboard"; // same signed message as the other Core tier routes
const QA_DAILY_LIMIT = Number(process.env.CONTRACT_QA_DAILY_LIMIT) || 20;

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

router.get("/contract-check/:target", async (req, res) => {
  const r = factsByIp(`facts:${clientIp(req)}`);
  if (!r.ok) return limited(res, r);
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
    if (!question) return res.json(await explainContract(facts));

    if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "Question must be text" });
    const used = await getQuestionCount(wallet, today());
    if (used >= QA_DAILY_LIMIT) return res.status(429).json({ error: `You've used today's ${QA_DAILY_LIMIT} questions — they reset at 00:00 UTC`, remaining: 0 });
    const answer = await answerQuestion(facts, question, { wallet });
    const count = await incrementQuestionCount(wallet, today());
    res.json({ ...answer, remaining: Math.max(0, QA_DAILY_LIMIT - (count ?? used + 1)) });
  } catch (err) {
    console.error(`⚠️  Contract Check: explain failed for ${address}:`, err.message);
    res.status(502).json({ error: "Couldn't explain that contract right now — try again shortly" });
  }
});

export default router;
