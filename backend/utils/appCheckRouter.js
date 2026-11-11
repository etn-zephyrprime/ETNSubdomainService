// Argus "App Check" API (services/appCheck/).
//
//   POST /api/app-check   { input, wallet?, signature?, timestamp? }
//     Without a signature (or for a wallet without Core): the free lookalike check — status, the app it is
//     or resembles, lookalike reasons, and a red badge for a lookalike. Never fetches anything external.
//     With a valid "Premium Dashboard" signature from a Core member: the full result (domain signals,
//     contracts with their Contract Check badges, overall badge).
//
//   POST /api/app-check/scan   { input, wallet, signature, timestamp } — Core only: the full result plus the
//     site scan (its page and scripts fetched through safeFetch.js, the contracts in them checked).
//     SCAN.scansPerMemberPerDay per member (in the database), plus the scanner's own server-wide limits
//     (concurrent scans, one scan per domain per minute).
//
// Rate limits per IP and per wallet (appCheck.config.js LIMITS).
import express from "express";
import { checkApp } from "../services/appCheck/appCheck.js";
import { LIMITS, SCAN } from "../services/appCheck/appCheck.config.js";
import { ScanUnavailable } from "../services/appCheck/scanSite.js";
import { getScanCount, incrementScanCount } from "../db/appScanUsage.js";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { createRateLimiter, clientIp } from "./rateLimit.js";

const router = express.Router();
const AUTH_PURPOSE = "Premium Dashboard"; // same signed message as the other Core tier routes
const byIp = createRateLimiter({ max: LIMITS.checksPerIpPer10Min, windowMs: 10 * 60 * 1000 });
const byWallet = createRateLimiter({ max: LIMITS.checksPerWalletPer10Min, windowMs: 10 * 60 * 1000 });

function limited(res, r) {
  res.set("Retry-After", String(r.retryAfterSec));
  res.status(429).json({ error: `Too many checks — try again in ${r.retryAfterSec}s` });
}

router.post("/app-check", express.json({ limit: "8kb" }), async (req, res) => {
  const { input, wallet, signature, timestamp } = req.body || {};
  if (typeof input !== "string" || !input.trim()) return res.status(400).json({ error: "Enter a website address or an app name" });
  if (input.length > LIMITS.maxInputLength) return res.status(400).json({ error: "That's too long to be a website address" });

  let core = false;
  if (signature) {
    try {
      verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const wR = byWallet(`app:${String(wallet).toLowerCase()}`);
    if (!wR.ok) return limited(res, wR);
    core = await hasCoreAccess(wallet);
  } else {
    const ipR = byIp(`app:${clientIp(req)}`);
    if (!ipR.ok) return limited(res, ipR);
  }

  try {
    res.json(await checkApp(input, { core }));
  } catch (err) {
    console.error("⚠️  App Check failed:", err.message);
    res.status(502).json({ error: "Couldn't check that right now — try again shortly" });
  }
});

router.post("/app-check/scan", express.json({ limit: "8kb" }), async (req, res) => {
  const { input, wallet, signature, timestamp } = req.body || {};
  if (typeof input !== "string" || !input.trim() || input.length > LIMITS.maxInputLength) return res.status(400).json({ error: "Enter a website address" });
  const ipR = byIp(`scan:${clientIp(req)}`);
  if (!ipR.ok) return limited(res, ipR);
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const wR = byWallet(`app:${String(wallet).toLowerCase()}`);
  if (!wR.ok) return limited(res, wR);
  if (!(await hasCoreAccess(wallet))) return res.status(403).json({ error: "Scanning a site is part of Core Tier" });

  const day = new Date().toISOString().slice(0, 10);
  try {
    const used = await getScanCount(wallet, day);
    if (used >= SCAN.scansPerMemberPerDay) return res.status(429).json({ error: `You've used today's ${SCAN.scansPerMemberPerDay} site scans — more tomorrow (UTC)`, scansLeft: 0 });
    const result = await checkApp(input, { core: true, scan: true });
    if (result.scan) await incrementScanCount(wallet, day); // only a scan that actually ran counts
    res.json({ ...result, scansLeft: Math.max(0, SCAN.scansPerMemberPerDay - used - (result.scan ? 1 : 0)) });
  } catch (err) {
    if (err instanceof ScanUnavailable) {
      res.set("Retry-After", String(err.retryAfterSec));
      return res.status(429).json({ error: err.message });
    }
    console.error("⚠️  App Check scan failed:", err.message);
    res.status(502).json({ error: "Couldn't scan that right now — try again shortly" });
  }
});

export default router;
