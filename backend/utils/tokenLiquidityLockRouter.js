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

// ElectroSwap's own lock-item schema is CONFIRMED LIVE (2026-09-18, real funded key, a real CORE
// lookup): { lockId, pair, owner, created (unix SECONDS), duration (SECONDS the lock runs for —
// there is no unlock-timestamp field at all), token0, token1, amountToken0, amountToken1 (raw
// integer strings), percentSupply, active (bool), version: "V2"|"V3" }. An earlier version of this
// function guessed at unlock-timestamp-shaped field names (unlockDate/unlockTimestamp/etc.) that
// don't exist — the real unlock time is `created + duration`.
//
// Only ACTIVE locks count — an inactive one (already unlocked, or withdrawn) isn't currently
// protecting anything, so including it would overstate how much liquidity is actually still locked
// right now. Exported so tokenLocksCache.js's own bulk refresh shares this exact parsing logic
// rather than a second, possibly-drifting copy.
export function normalizeLocks(rawLocks) {
  if (!Array.isArray(rawLocks)) return { count: 0, latestUnlockAt: null };

  const activeLocks = rawLocks.filter((l) => l?.active !== false);

  let latestUnlockMs = null;
  for (const lock of activeLocks) {
    const created = Number(lock?.created);
    const duration = Number(lock?.duration);
    if (!Number.isFinite(created) || !Number.isFinite(duration)) continue;
    const unlockMs = (created + duration) * 1000;
    if (latestUnlockMs == null || unlockMs > latestUnlockMs) latestUnlockMs = unlockMs;
  }

  return {
    count: activeLocks.length,
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
