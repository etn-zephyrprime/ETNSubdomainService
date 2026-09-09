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
  for (const w of active) {
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

  res.json({ perWallet, combined: { positions: allPositions, totalUsd, hasUnpriced } });
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

  res.json({ perWallet, combined: { totalUsd, hasUnpriced, lpTokenAddresses: [...allLpTokenAddresses] } });
});

export default router;
