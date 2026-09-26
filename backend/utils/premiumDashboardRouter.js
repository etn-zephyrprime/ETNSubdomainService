// backend/utils/premiumDashboardRouter.js
//
// HTTP surface for Core tier — the first premium dashboard feature beyond PnL Statements: up to
// MAX_TRACKED_WALLETS explicitly-tracked wallets a member can add, PLUS their own connected wallet
// (always included automatically, doesn't spend one of those slots — see trackedWallets.js's
// getCoveredWallets) for the combined portfolio view (see
// src/dashboard/premium/components/CoreTierPortfolio.jsx). Every endpoint here requires the same
// signed proof of wallet ownership GET /pnl/statements uses (walletAuth.js) — keyed on nothing but
// a bare wallet address otherwise, same reasoning as that route's own comment — AND an active
// Core tier membership (hasCoreAccess: either PremiumSubscription tier, see premiumAccess.js).
// Mounted at /api/premium in backend/index.js.
//
// Add/remove are separate endpoints (not a single "PUT the whole list") deliberately: each of the
// two 30-day cooldowns (can't untrack a just-added wallet, can't re-track a just-removed one — see
// trackedWallets.js / migrations/007_tracked_wallets.sql) is checked against ONE wallet's own
// add/remove history. A whole-list replace would have to diff the old and new arrays to even know
// which addresses are "new adds" needing a cooldown check in the first place — fragile, and an
// easy place for the cooldown to quietly stop applying. One wallet per call sidesteps that
// entirely.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import {
  getCoveredWallets,
  getCoolingDownWallets,
  addTrackedWallet,
  removeTrackedWallet,
  MAX_TRACKED_WALLETS,
  TRACK_COOLDOWN_DAYS,
} from "../db/trackedWallets.js";
import { getOpenDefiPositionsUsd } from "../services/defiPositionValuation.js";
import { getLiquidityPositionsUsd } from "../services/lpPositionValuation.js";
import { checkAndStartDefiIngestIfNeeded } from "../services/pnlIngestion.js";
import { getPortfolioSummary, upsertPortfolioSummary } from "../db/portfolioSummaryCache.js";

// Folded into the signed message (see walletAuth.js) — one literal shared by every route below,
// so a signature cached client-side (see useWalletAuthSignature.js) works across all of them
// within its lifetime instead of forcing a fresh signature per action.
const AUTH_PURPOSE = "Premium Dashboard";

function requireAuthAndAccess(req, res, wallet, signature, timestamp) {
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
    return true;
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
}

/** wallet_ingestion_jobs row -> the shape the frontend polls (see CoreTierPortfolio.jsx). Same
 * shape as pnlSnapshotRouter.js's own identical helper — duplicated rather than shared across
 * router files, same "small per-file helpers are fine to drift independently" convention this
 * backend already uses elsewhere. */
function serializeJob(walletAddress, job) {
  return {
    walletAddress,
    status: job?.status || "RUNNING",
    stage: job?.stage || "Starting…",
    current: job?.progress_current != null ? Number(job.progress_current) : 0,
    total: job?.progress_total != null ? Number(job.progress_total) : 0,
    errorMessage: job?.error_message || null,
  };
}

const router = express.Router();

router.get("/premium/tracked-wallets", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;

  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const [active, cooling] = await Promise.all([
    getCoveredWallets(wallet),
    getCoolingDownWallets(wallet),
  ]);
  res.json({ active, cooling, maxWallets: MAX_TRACKED_WALLETS, cooldownDays: TRACK_COOLDOWN_DAYS });
});

router.post("/premium/tracked-wallets", async (req, res) => {
  const { wallet, signature, timestamp, walletToTrack } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!walletToTrack || !ethers.isAddress(walletToTrack)) {
    return res.status(400).json({ error: "walletToTrack must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;

  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  try {
    // addTrackedWallet itself returns getActiveTrackedWallets's explicit-only list (that's what
    // its own cap check needs) — re-fetched here via getCoveredWallets so this endpoint's response
    // always includes the owner's own wallet too, same shape as the GET above.
    await addTrackedWallet(wallet, walletToTrack);
    const active = await getCoveredWallets(wallet);
    res.json({ active, maxWallets: MAX_TRACKED_WALLETS, cooldownDays: TRACK_COOLDOWN_DAYS });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/premium/tracked-wallets", async (req, res) => {
  const { wallet, signature, timestamp, walletToUntrack } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!walletToUntrack || !ethers.isAddress(walletToUntrack)) {
    return res.status(400).json({ error: "walletToUntrack must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;

  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  try {
    // Same reasoning as the POST handler above — re-fetch via getCoveredWallets for a consistent
    // response shape across all three endpoints.
    await removeTrackedWallet(wallet, walletToUntrack);
    const active = await getCoveredWallets(wallet);
    res.json({ active, maxWallets: MAX_TRACKED_WALLETS, cooldownDays: TRACK_COOLDOWN_DAYS });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Live value of every currently-open yield-farm/staking position, per covered wallet AND combined
// — the counterpart to Combined Holdings/Total Portfolio Balance's Blockscout-only token-balance
// view, which has no way to see funds that have moved into a farm/staking contract (see
// defiPositionValuation.js's own header comment). A separate endpoint rather than folded into GET
// /premium/tracked-wallets above: this does real on-chain reads (not just a DB lookup) and a member
// with no DeFi activity at all shouldn't pay for it on every tracked-wallet-list fetch.
router.get("/premium/defi-positions", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  const perWallet = [];
  const jobs = [];
  for (const w of active) {
    // Every reconnect/load attempts a fresh DeFi sync (same "always sync, short grace period"
    // design as pnlSnapshotRouter.js's own /pnl-snapshot — see checkAndStartDefiIngestIfNeeded's
    // own header comment), reporting live progress instead of blocking this response on a
    // genuinely slow cold-start scan. Wrapped in try/catch for the same reason as that file's own
    // identical guard: this progress-reporting layer must never be able to take the whole endpoint
    // down for every member over what's fundamentally a nice-to-have (a live progress readout) —
    // a failure here falls back to computing normally, same as before this feature existed.
    let ingestCheck;
    try {
      ingestCheck = await checkAndStartDefiIngestIfNeeded(w.address);
    } catch (err) {
      console.error(`⚠️  checkAndStartDefiIngestIfNeeded failed for wallet ${w.address} (falling back to computing normally):`, err.message);
      ingestCheck = { needed: false };
    }
    if (ingestCheck.needed) {
      jobs.push(serializeJob(w.address, ingestCheck.job));
      continue;
    }

    try {
      const result = await getOpenDefiPositionsUsd(w.address);
      perWallet.push({ walletAddress: w.address, ...result });
    } catch (err) {
      console.error(`DeFi position lookup failed for wallet ${w.address}:`, err);
      perWallet.push({ walletAddress: w.address, positions: [], totalUsd: null, hasUnpriced: true, failed: true });
    }
  }

  let totalUsd = null;
  let hasUnpriced = false;
  const allPositions = [];
  for (const w of perWallet) {
    if (w.totalUsd != null) totalUsd = (totalUsd ?? 0) + Number(w.totalUsd);
    if (w.hasUnpriced) hasUnpriced = true;
    for (const p of w.positions) allPositions.push({ ...p, walletAddress: w.walletAddress });
  }

  // A wallet still ingesting (in `jobs`) simply doesn't contribute to `perWallet`/`combined` yet —
  // whatever DID finish this round still shows, same "partial results over blocking everything"
  // reasoning as pnlSnapshotRouter.js's own identical shape.
  //
  // `refreshing` (distinct from `ingesting`): true when at least one wallet's own result came from
  // getOpenDefiPositionsUsd's persisted cache but is now known stale (see that function's own
  // `refreshing` comment) — a background recompute is already running. Unlike `ingesting`, this
  // wallet's real (if momentarily outdated) figures ARE already included above; the frontend should
  // keep showing them as normal and just poll again shortly for the refreshed ones, not hide them
  // behind a progress banner the way `ingesting` (genuinely nothing to show yet) does.
  const refreshing = perWallet.some((w) => w.refreshing);
  res.json({ perWallet, combined: { positions: allPositions, totalUsd, hasUnpriced }, ingesting: jobs.length > 0, jobs, refreshing });
});

// Live value of every LP/V3 position covered wallets DIRECTLY hold (not locked in a farm/staking
// contract — see defiPositionValuation.js's own comment on that distinction), per wallet AND
// combined. A POST, not a GET like the other endpoints on this router: valuing a V2 LP token
// requires knowing which of a wallet's held tokens are worth even probing as candidate pools, and
// that token list already lives client-side (useCombinedPortfolio.js calls Blockscout directly,
// no backend round-trip) — sending it here avoids this endpoint independently re-fetching the same
// balances Combined Holdings already has loaded. `walletTokens` is keyed by lowercased wallet
// address; a wallet with no entry (or an empty list) just skips V2 LP candidate-checking for it —
// V3 position discovery below is unaffected either way, since that's a live Blockscout NFT lookup
// with no dependency on the caller's own token list.
router.post("/premium/liquidity-positions", async (req, res) => {
  const { wallet, signature, timestamp, walletTokens } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  const perWallet = [];
  for (const w of active) {
    const candidateTokens = walletTokens?.[w.address.toLowerCase()] || [];
    try {
      const result = await getLiquidityPositionsUsd(w.address, candidateTokens);
      perWallet.push({ walletAddress: w.address, ...result, lpTokenAddresses: [...result.lpTokenAddresses] });
    } catch (err) {
      console.error(`Liquidity position lookup failed for wallet ${w.address}:`, err);
      perWallet.push({ walletAddress: w.address, v2Positions: [], v3Positions: [], totalUsd: null, hasUnpriced: true, lpTokenAddresses: [], failed: true });
    }
  }

  let totalUsd = null;
  let hasUnpriced = false;
  const allLpTokenAddresses = new Set();
  for (const w of perWallet) {
    if (w.totalUsd != null) totalUsd = (totalUsd ?? 0) + Number(w.totalUsd);
    if (w.hasUnpriced) hasUnpriced = true;
    for (const addr of w.lpTokenAddresses) allLpTokenAddresses.add(addr);
  }

  // See the identical `refreshing` comment on /premium/defi-positions above — same meaning here:
  // at least one wallet's figures came from a persisted-but-now-stale cache row, with a background
  // recompute already running. The real (if momentarily outdated) figures are already in `perWallet`
  // above; the frontend should keep showing them and just poll again shortly.
  const refreshing = perWallet.some((w) => w.refreshing);
  // The combined view needs the actual position rows too (not just the total) — CoreTierPortfolio's
  // Liquidity Positions list reads `combined.v2Positions/v3Positions` when no single wallet is
  // filtered, and this used to omit them, so the "All wallets" view counted liquidity in the total but
  // listed none of it. Each row keeps its wallet so two wallets in the same pool stay distinguishable.
  const tag = (list, walletAddress) => (list || []).map((p) => ({ ...p, walletAddress }));
  const v2Positions = perWallet.flatMap((w) => tag(w.v2Positions, w.walletAddress));
  const v3Positions = perWallet.flatMap((w) => tag(w.v3Positions, w.walletAddress));
  res.json({ perWallet, combined: { totalUsd, hasUnpriced, lpTokenAddresses: [...allLpTokenAddresses], v2Positions, v3Positions }, refreshing });
});


// Last-known portfolio summary — see migrations/018_portfolio_summary_cache.sql. GET is what the
// Portfolio tab reads FIRST on load so real numbers show immediately; POST is the tab saving its own
// freshly-settled live figures back. The figures are computed client-side (native/token balances come
// straight from Blockscout in the browser), so the server never trusts the body as-is: it rebuilds a
// bounded object from finite, non-negative numbers for covered wallets only, so a bad/odd client can
// only ever put junk in its OWN member's cached display, never anything structural.
const MAX_SUMMARY_USD = 1e12;
function cleanUsd(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SUMMARY_USD ? n : null;
}

router.get("/premium/portfolio-summary", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }
  try {
    const row = await getPortfolioSummary(wallet);
    res.json(row ? { summary: row.payload, computedAt: row.computedAt } : { summary: null, computedAt: null });
  } catch (err) {
    // A cache read must never break the tab — degrade to "nothing saved yet".
    console.error("⚠️  Portfolio summary read failed:", err.message);
    res.json({ summary: null, computedAt: null });
  }
});

router.post("/premium/portfolio-summary", async (req, res) => {
  const { wallet, signature, timestamp, summary } = req.body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const covered = new Set((await getCoveredWallets(wallet)).map((w) => w.address.toLowerCase()));
  const perWallet = [];
  for (const w of Array.isArray(summary?.perWallet) ? summary.perWallet.slice(0, 10) : []) {
    if (!w || !ethers.isAddress(w.address) || !covered.has(String(w.address).toLowerCase())) continue;
    const native = cleanUsd(w.native);
    const tokens = cleanUsd(w.tokens);
    const liquidity = cleanUsd(w.liquidity);
    const staking = cleanUsd(w.staking);
    if ([native, tokens, liquidity, staking].some((v) => v === null)) continue;
    perWallet.push({ address: String(w.address).toLowerCase(), native, tokens, liquidity, staking });
  }
  if (perWallet.length === 0) return res.status(400).json({ error: "No valid wallets in summary" });

  try {
    await upsertPortfolioSummary(wallet, { perWallet, hasUnpriced: Boolean(summary?.hasUnpriced) });
    res.json({ ok: true });
  } catch (err) {
    console.error("⚠️  Portfolio summary save failed:", err.message);
    res.status(500).json({ error: "Couldn't save summary" });
  }
});

export default router;
