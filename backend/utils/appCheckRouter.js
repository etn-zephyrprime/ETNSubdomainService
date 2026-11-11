// Argus "App Check" API (services/appCheck/).
//
//   POST /api/app-check          { input, wallet?, signature?, timestamp? }
//     Without a signature (or for a wallet without Core): the free lookalike check — status, the app it is
//     or resembles, lookalike reasons, and a red badge for a lookalike. Never fetches anything external.
//     With a valid "Premium Dashboard" signature from a Core member: the full result (domain signals,
//     contracts with their Contract Check badges, overall badge), from the cache when it's fresh
//     (appCheckService.js revalidates it cheaply first), with the app's recent changes.
//
//   POST /api/app-check/scan     { input, rescan?, wallet, signature, timestamp } — Core only: the full result
//     plus the site scan (its page and scripts fetched through safeFetch.js, the contracts in them checked).
//     A stored scan is reused unless `rescan`. SCAN.scansPerMemberPerDay scans per member (only scans that
//     actually ran count), plus the scanner's own server-wide limits (concurrent scans, one per domain/min).
//
//   POST /api/app-check/follow   { input, follow: true | false, wallet, signature, timestamp } — Core only:
//     watch / unwatch an app (FOLLOW.maxPerMember). Alerts go to the member's linked Telegram.
//   GET  /api/app-check/follows  (wallet, signature, timestamp as query params) — the member's watched apps.
//
// Rate limits per IP and per wallet (appCheck.config.js LIMITS).
import express from "express";
import { getAppResult, followApp, unfollowApp } from "../services/appCheck/appCheckService.js";
import { LIMITS, SCAN } from "../services/appCheck/appCheck.config.js";
import { ScanUnavailable } from "../services/appCheck/scanSite.js";
import { getScanCount, incrementScanCount } from "../db/appScanUsage.js";
import { listAppFollows } from "../db/appCheck.js";
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

/** Signature + per-wallet limit + Core. Sends the error and returns null on failure; else the wallet. */
async function requireCore(res, { wallet, signature, timestamp }, message = "Core Tier membership required") {
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    res.status(401).json({ error: err.message });
    return null;
  }
  const wR = byWallet(`app:${String(wallet).toLowerCase()}`);
  if (!wR.ok) {
    limited(res, wR);
    return null;
  }
  if (!(await hasCoreAccess(wallet))) {
    res.status(403).json({ error: message });
    return null;
  }
  return String(wallet).toLowerCase();
}

const validInput = (input) => typeof input === "string" && input.trim() && input.length <= LIMITS.maxInputLength;

router.post("/app-check", express.json({ limit: "8kb" }), async (req, res) => {
  const { input, wallet, signature, timestamp } = req.body || {};
  if (!validInput(input)) return res.status(400).json({ error: "Enter a website address or an app name" });

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
    res.json(await getAppResult(input, { core }));
  } catch (err) {
    console.error("⚠️  App Check failed:", err.message);
    res.status(502).json({ error: "Couldn't check that right now — try again shortly" });
  }
});

router.post("/app-check/scan", express.json({ limit: "8kb" }), async (req, res) => {
  const { input, rescan } = req.body || {};
  if (!validInput(input)) return res.status(400).json({ error: "Enter a website address" });
  const ipR = byIp(`scan:${clientIp(req)}`);
  if (!ipR.ok) return limited(res, ipR);
  const wallet = await requireCore(res, req.body || {}, "Scanning a site is part of Core Tier");
  if (!wallet) return;

  const day = new Date().toISOString().slice(0, 10);
  try {
    const used = await getScanCount(wallet, day);
    const left = SCAN.scansPerMemberPerDay - used;
    if (left <= 0) return res.status(429).json({ error: `You've used today's ${SCAN.scansPerMemberPerDay} site scans — more tomorrow (UTC)`, scansLeft: 0 });
    const result = await getAppResult(input, { core: true, scan: true, force: rescan === true });
    if (result.scanRan) await incrementScanCount(wallet, day); // only a scan that actually ran counts
    res.json({ ...result, scansLeft: Math.max(0, left - (result.scanRan ? 1 : 0)) });
  } catch (err) {
    if (err instanceof ScanUnavailable) {
      res.set("Retry-After", String(err.retryAfterSec));
      return res.status(429).json({ error: err.message });
    }
    console.error("⚠️  App Check scan failed:", err.message);
    res.status(502).json({ error: "Couldn't scan that right now — try again shortly" });
  }
});

router.post("/app-check/follow", express.json({ limit: "8kb" }), async (req, res) => {
  const { input, follow } = req.body || {};
  if (!validInput(input)) return res.status(400).json({ error: "Enter a website address or an app name" });
  const wallet = await requireCore(res, req.body || {}, "Watching apps is part of Core Tier");
  if (!wallet) return;
  try {
    const r = follow === false ? await unfollowApp(wallet, input) : await followApp(wallet, input);
    if (!r.ok && r.error) return res.status(400).json({ error: r.error });
    res.json({ ...r, follows: await listAppFollows(wallet) });
  } catch (err) {
    console.error("⚠️  App Check follow failed:", err.message);
    res.status(502).json({ error: "Couldn't update that right now — try again shortly" });
  }
});

router.get("/app-check/follows", async (req, res) => {
  const wallet = await requireCore(res, req.query || {});
  if (!wallet) return;
  try {
    res.json({ follows: await listAppFollows(wallet) });
  } catch (err) {
    console.error("⚠️  App Check follows failed:", err.message);
    res.status(502).json({ error: "Couldn't load your watched apps right now" });
  }
});

export default router;
