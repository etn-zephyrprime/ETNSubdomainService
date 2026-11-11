// Argus "App Check" API (services/appCheck/).
//
//   POST /api/app-check   { input, wallet?, signature?, timestamp? }
//     Without a signature (or for a wallet without Core): the free lookalike check — status, the app it is
//     or resembles, lookalike reasons, and a red badge for a lookalike. Never fetches anything external.
//     With a valid "Premium Dashboard" signature from a Core member: the full result (domain signals,
//     contracts with their Contract Check badges, overall badge).
//
// Rate limits per IP and per wallet (appCheck.config.js LIMITS).
import express from "express";
import { checkApp } from "../services/appCheck/appCheck.js";
import { LIMITS } from "../services/appCheck/appCheck.config.js";
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

export default router;
