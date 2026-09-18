// backend/utils/tokenLiquidityLockRouter.js
//
// Public (no auth — this is the free Tokens tab) per-token liquidity-lock lookup, backing
// TokenDetail.jsx's "Liquidity Lock" stat card. Deliberately LAZY and per-token-viewed, unlike
// tokenLiquidityCache.js's bulk scheduled refresh — ElectroSwap's own /liquidity-locks endpoint is
// flagged `heavy: true` in their OpenAPI spec (global concurrency limits, expect occasional 503
// "server_busy" under load) and costs a flat 2000 credits with no batching, so calling it for
// every token in a list (or on a timer for tokens nobody's actually looking at) would be both slow
// and needlessly expensive. This only ever calls it for a token a visitor actually opened, and
// caches the result in memory so the SAME token doesn't re-pay that cost on every subsequent view.
//
// In-memory, not R2-backed like this backend's other caches — losing this cache on a Render
// restart just means the next viewer of an already-seen token pays one more 2000-credit call, which
// is an acceptable, self-healing cost for a "nice to have" feature, not worth the extra R2 plumbing
// a fresh generic per-key store would need (unlike e.g. token prices, where losing the cache would
// visibly blank pricing across the whole app for everyone at once).
import { ethers } from "ethers";
import express from "express";
import { getLiquidityLocks, isElectroSwapConfigured } from "./electroSwapApi.js";

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000; // a lock's terms rarely change; long TTL keeps repeat views free
const FAILURE_TTL_MS = 5 * 60 * 1000; // a transient 503/unavailable result shouldn't stick for a full day

const cache = new Map(); // lowercased address -> { expiresAt, result }

// ElectroSwap's own lock-item schema is NOT confirmed live (untyped Envelope.data — see
// electroSwapApi.js's own getLiquidityLocks comment, no funded key available to verify a real
// response while building this). Deliberately extracts as LITTLE as possible from each lock's own
// fields — just how many locks exist (always safe: an array's own length) and, best-effort, an
// unlock date if a recognizable field is present — rather than trying to reconstruct amount/
// percent-locked details this can't confidently verify. A visitor who wants the full breakdown gets
// a link to ElectroSwap's own page for it (see the frontend's own TokenDetail.jsx).
function normalizeLocks(rawLocks) {
  if (!Array.isArray(rawLocks)) return { count: 0, latestUnlockAt: null };

  let latestUnlockMs = null;
  for (const raw of rawLocks) {
    const rawDate = raw?.unlockDate ?? raw?.unlockTimestamp ?? raw?.unlocksAt ?? raw?.expiresAt ?? raw?.lockedUntil ?? raw?.endTime;
    if (rawDate == null) continue;
    // Accept either unix seconds or milliseconds, or an ISO string — same "don't assume one shape"
    // caution as everywhere else touching this unconfirmed API.
    const ms = typeof rawDate === "number" ? (rawDate > 1e12 ? rawDate : rawDate * 1000) : new Date(rawDate).getTime();
    if (Number.isFinite(ms) && (latestUnlockMs == null || ms > latestUnlockMs)) latestUnlockMs = ms;
  }

  return {
    count: rawLocks.length,
    latestUnlockAt: latestUnlockMs != null ? new Date(latestUnlockMs).toISOString() : null,
  };
}

const router = express.Router();

router.get("/token-liquidity-lock/:address", async (req, res) => {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: "Invalid token address" });
  }
  if (!isElectroSwapConfigured()) {
    return res.json({ available: false });
  }

  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.result);
  }

  const rawLocks = await getLiquidityLocks(address);
  const result = rawLocks == null ? { available: false } : { available: true, ...normalizeLocks(rawLocks) };
  cache.set(key, { expiresAt: Date.now() + (result.available ? SUCCESS_TTL_MS : FAILURE_TTL_MS), result });
  res.json(result);
});

export default router;
