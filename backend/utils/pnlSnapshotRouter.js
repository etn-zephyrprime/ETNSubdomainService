// backend/utils/pnlSnapshotRouter.js
//
// HTTP surface for Core tier's "ongoing dashboard PnL" feature — see pnlSnapshotService.js's own
// header comment for what this is and, just as importantly, what it explicitly is NOT (not the
// PnL Statement product; no CEX inclusion, no fixed periods, no immutability, no per-disposal
// ledger). Same auth shape as every other Core tier router: signed proof of wallet ownership
// (walletAuth.js) plus an active Core tier membership (hasCoreAccess). Mounted at /api/premium in
// backend/index.js, alongside premiumDashboardRouter.js/premiumAlertsRouter.js.
import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getPnlSnapshotHistory, combineSnapshotsByDate } from "../db/pnlSnapshots.js";
import { getPnlCategorySnapshotHistory, combineCategorySnapshotsByDate } from "../db/pnlCategorySnapshots.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { checkAndStartIngestIfNeeded } from "../services/pnlIngestion.js";
import { computeLivePnlSnapshot, combineLivePnlSnapshots, getSnapshotFast } from "../services/pnlSnapshotService.js";
import { computeLiveNftPnlSnapshot, combineLiveNftPnlSnapshots } from "../services/nftPnlService.js";
import { CATEGORIES } from "../services/categoryPnlService.js";
import { computeTokenPnlHistory, combineTokenPnlHistory } from "../services/tokenPnlService.js";
import { fetchBlockscoutJson } from "./blockscoutClient.js";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);

/** A wallet's CURRENT token holdings, cheap to fetch (one Blockscout call, no ingestion/FIFO
 * replay at all) — the selectable list for the cold-start token picker. Deliberately scoped to
 * current holdings, not full historical activity: a token the wallet has fully disposed of isn't
 * something a member is likely to want prioritized for a LIVE "how am I doing right now" view
 * anyway, and it still gets priced eventually via the background backfill regardless of whether
 * it was ever selectable here. */
async function getSelectableTokens(walletAddress) {
  try {
    const res = await fetchBlockscoutJson(`/addresses/${walletAddress}/token-balances`);
    const balances = Array.isArray(res) ? res : res?.items || [];
    return balances
      .filter((b) => b.token?.address && !NFT_TOKEN_TYPES.has(b.token?.type) && BigInt(b.value || 0) > 0n)
      .map((b) => ({ address: b.token.address, symbol: b.token.symbol || null, name: b.token.name || null }));
  } catch (err) {
    console.warn(`⚠️  PnL snapshot: couldn't fetch selectable tokens for ${walletAddress}:`, err.message);
    return [];
  }
}

/** wallet_ingestion_jobs row -> the shape the frontend polls (see CoreTierPnl.jsx). Camel-cased,
 * and only the fields a progress UI actually needs — never the raw DB row (no started_at, no
 * error detail beyond the message itself). */
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

const AUTH_PURPOSE = "Premium Dashboard"; // same literal every Core tier endpoint signs — one cached signature covers all of them
// Matches CoreTierBalanceHistory.jsx's own WINDOW_DAYS default — a rolling 12 months is this
// dashboard's established convention for "how far back" unless a caller asks for more (see the
// build brief's own decision: pnl_snapshots is cheap enough to keep everything, so "all-time on
// request" costs nothing extra to support, but the default should match the rest of the page).
const DEFAULT_HISTORY_DAYS = 365;

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

// Live "right now" figures — current holdings, unrealized P&L, running realized P&L — per tracked
// wallet AND combined. Recomputed fresh on every call (see pnlSnapshotService.js's own comment on
// why this is never cached/frozen here); a member with 3 tracked wallets and real history should
// expect this to take real time, the same order of magnitude as generating a PnL Statement does,
// since it's doing the same FIFO replay + live pricing work — UNLESS this is a wallet's first-ever
// computation and priorityTokens scopes it (see below), which is the whole point of that feature.
//
// `priorityTokens` (optional): a JSON-encoded `{ [walletAddress]: [tokenAddress, ...] }` map — the
// cold-start speedup the member opts into by picking which tokens to prioritize (see
// pnlSnapshotService.computeLivePnlSnapshot's own header comment for the full mechanism and its
// safety boundary). Any wallet that's STILL mid-cold-start and has NO entry in this map doesn't
// get computed at all on this call — it comes back in `needsSelection` instead, with its current
// holdings as the pickable list, so the frontend can prompt for a selection before retrying. A
// wallet that's already past cold-start never appears in `needsSelection` regardless of
// priorityTokens — there's nothing to speed up for it anymore.
router.get("/premium/pnl-snapshot", async (req, res) => {
  const { wallet, signature, timestamp, priorityTokens: priorityTokensRaw } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  let priorityTokensByWallet = {};
  if (priorityTokensRaw) {
    try {
      priorityTokensByWallet = JSON.parse(priorityTokensRaw);
    } catch {
      return res.status(400).json({ error: "priorityTokens must be valid JSON" });
    }
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ perWallet: [], combined: null, failed: [], needsSelection: [] });
  }

  try {
    const addresses = active.map((w) => w.address);
    const perWallet = [];
    const failed = [];
    const needsSelection = [];
    const jobs = [];
    let refreshing = false; // at least one wallet's figures are SAVED ones being refreshed in the background
    let staleAsOf = null; // the oldest computedAt among those
    // Sequential, not Promise.all — same reasoning as pnlSnapshotScheduler.js's own poll loop: a
    // full FIFO replay + live pricing per wallet is real work, and a member only ever has up to 4
    // covered wallets (their own connected wallet + up to 3 explicitly tracked — see
    // getCoveredWallets), so there's no responsiveness win worth the burst RPC/pricing load.
    //
    // Each wallet's computation is isolated in its own try/catch — confirmed live this used to be
    // ONE try wrapping the whole loop, so a single wallet's transient failure (an RPC hiccup, a
    // price lookup error, anything computeLivePnlSnapshot doesn't already swallow internally)
    // discarded the OTHER wallets' already-computed results along with it, blanking the entire
    // panel instead of just the one wallet that actually failed.
    for (const address of addresses) {
      const selfOwnedAddresses = addresses.filter((a) => a !== address);
      const priorityTokens = priorityTokensByWallet[address];
      const state = await getIngestionState(address);

      if (!priorityTokens && !state?.cold_start_completed_at) {
        // No selection given for this wallet on this call, and it's still cold-starting — check
        // whether it actually needs one before deciding to skip computing it. Deliberately BEFORE
        // the ingest-progress check below: a brand-new wallet must go through this prompt first,
        // not have a full unscoped ingest silently kicked off underneath it before the member ever
        // gets to choose which tokens to prioritize (see computeLivePnlSnapshot's own
        // priorityAssets/SAFETY BOUNDARY comment for why that scoping only ever applies pre-cold-start).
        needsSelection.push({ walletAddress: address, availableTokens: await getSelectableTokens(address) });
        continue;
      }

      // Fast path: a fresh in-memory snapshot, or one SAVED in Supabase from an earlier computation
      // (served right away while a single background recompute refreshes it) — see getSnapshotFast.
      // Skips the ingest gate below: the recompute runs ingestWalletHistory itself, and the gate only
      // exists to report progress for a slow SYNCHRONOUS run, which this path never does.
      try {
        const fast = await getSnapshotFast(address, selfOwnedAddresses);
        if (fast) {
          perWallet.push({ walletAddress: address, ...fast.snapshot });
          if (fast.refreshing) {
            refreshing = true;
            if (!staleAsOf || new Date(fast.computedAt) < new Date(staleAsOf)) staleAsOf = fast.computedAt;
          }
          continue;
        }
      } catch (err) {
        console.error(`⚠️  getSnapshotFast failed for wallet ${address} (computing normally):`, err.message);
      }

      // Every reconnect attempts a fresh sync (see checkAndStartIngestIfNeeded's own header
      // comment — deliberately no time-based staleness skip) but gives it a short grace period to
      // finish outright first: a wallet with nothing new since last visit resumes almost instantly
      // and falls through to computeLivePnlSnapshot below same as before this feature existed; only
      // a genuinely slow run (cold start, real new activity) reports live progress instead of
      // blocking this response on it.
      const priorityAssets =
        !state?.cold_start_completed_at && priorityTokens?.length > 0
          ? new Set(priorityTokens.map((a) => a.toLowerCase()))
          : null; // matches computeLivePnlSnapshot's own isColdStart-gated scoping exactly
      // This progress-reporting layer must never be able to take the whole panel down for every
      // member over what's fundamentally a nice-to-have (a live progress readout) — confirmed live:
      // wallet_ingestion_jobs missing entirely (an unrun migration) threw straight out of this loop,
      // past every other wallet's own try/catch below, and 502'd the entire response for every Core
      // Tier member simultaneously. A failure here now just falls back to the exact pre-this-feature
      // behavior: proceed to computeLivePnlSnapshot, which still calls ingestWalletHistory itself
      // regardless — ingestion isn't skipped, only its live progress readout is unavailable this call.
      let ingestCheck;
      try {
        ingestCheck = await checkAndStartIngestIfNeeded(address, selfOwnedAddresses, priorityAssets);
      } catch (err) {
        console.error(`⚠️  checkAndStartIngestIfNeeded failed for wallet ${address} (falling back to computing normally):`, err.message);
        ingestCheck = { needed: false };
      }
      if (ingestCheck.needed) {
        jobs.push(serializeJob(address, ingestCheck.job));
        continue;
      }

      try {
        const snapshot = await computeLivePnlSnapshot(address, selfOwnedAddresses, priorityTokens || null);
        perWallet.push({ walletAddress: address, ...snapshot });
      } catch (err) {
        console.error(`PnL snapshot computation failed for wallet ${address}:`, err);
        failed.push(address);
      }
    }
    // combineLivePnlSnapshots handles a single wallet correctly too (sum of one is just that one),
    // and correctly reflects only the wallets that actually succeeded — `failed` tells the
    // frontend which ones didn't, rather than silently under-reporting the combined total. A
    // wallet still ingesting (in `jobs`) simply doesn't contribute to `perWallet`/`combined` yet —
    // whatever DID finish this round still shows, rather than blocking everything on the slowest
    // wallet.
    const combined = perWallet.length > 0 ? combineLivePnlSnapshots(perWallet) : null;
    res.json({ perWallet, combined, failed, needsSelection, ingesting: jobs.length > 0, jobs, refreshing, staleAsOf });
  } catch (err) {
    console.error("PnL snapshot computation failed:", err);
    res.status(502).json({ error: "Couldn't compute your live PnL right now — try again shortly" });
  }
});

// Live NFT PnL — cost basis (held + sold), and proceeds/realized P&L for anything sold, at all
// three tiers (top-level, per-collection, per-token-ID) — see nftPnlService.js's own header
// comment. No priorityTokens concept here (unlike the fungible endpoint above): NFT PnL needs no
// live price lookups at all, so there's no cold-start slowdown to scope around.
router.get("/premium/nft-pnl", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ perWallet: [], combined: null, failed: [] });
  }

  try {
    const addresses = active.map((w) => w.address);
    const perWallet = [];
    const failed = [];
    // Sequential and independently try/caught — same reasoning as the fungible endpoint above: a
    // full transfer-history walk + FIFO replay per wallet is real work, and one wallet's transient
    // failure shouldn't blank out the others' already-computed results.
    for (const address of addresses) {
      const selfOwnedAddresses = addresses.filter((a) => a !== address);
      try {
        const snapshot = await computeLiveNftPnlSnapshot(address, selfOwnedAddresses);
        perWallet.push({ walletAddress: address, ...snapshot });
      } catch (err) {
        console.error(`NFT PnL computation failed for wallet ${address}:`, err);
        failed.push(address);
      }
    }
    const combined = perWallet.length > 0 ? combineLiveNftPnlSnapshots(perWallet) : null;
    res.json({ perWallet, combined, failed });
  } catch (err) {
    console.error("NFT PnL computation failed:", err);
    res.status(502).json({ error: "Couldn't compute your NFT PnL right now — try again shortly" });
  }
});

// Value-over-time chart data — reads the daily rollup pnlSnapshotScheduler.js writes, never
// recomputes history live (that's what the endpoint above is for "right now"). `days` defaults to
// DEFAULT_HISTORY_DAYS; pass `days=all` for the wallet's entire history since cold-start — cheap
// either way, this table is a plain daily rollup, not a full replay.
router.get("/premium/pnl-history", async (req, res) => {
  const { wallet, signature, timestamp, days } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ perWallet: [], combined: [] });
  }

  const sinceDate =
    days === "all"
      ? new Date(0)
      : new Date(Date.now() - (Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : DEFAULT_HISTORY_DAYS) * 24 * 60 * 60 * 1000);

  const addresses = active.map((w) => w.address);
  const rows = await getPnlSnapshotHistory(wallet, addresses, sinceDate.toISOString().slice(0, 10));
  const combined = combineSnapshotsByDate(rows, addresses);

  const perWallet = addresses.map((address) => ({
    walletAddress: address,
    points: rows.filter((r) => r.walletAddress === address),
  }));

  res.json({ perWallet, combined });
});

// Category value-over-time chart data — "Liquidity Positions" or "Staking / Yield Farms", same
// read-only-rollup shape as /premium/pnl-history above, just scoped to one category (see
// categoryPnlService.js's own comment for exactly what that category does and doesn't cover —
// notably, it does NOT include the live value of currently-open/locked positions, only PnL
// history from disposals and reward income; see the Portfolio page's own Liquidity Positions /
// Staked & Farming Positions sections for live "right now" figures instead).
router.get("/premium/pnl-category-history", async (req, res) => {
  const { wallet, signature, timestamp, category, days } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!Object.values(CATEGORIES).includes(category)) {
    return res.status(400).json({ error: `Query param category must be one of: ${Object.values(CATEGORIES).join(", ")}` });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ perWallet: [], combined: [] });
  }

  const sinceDate =
    days === "all"
      ? new Date(0)
      : new Date(Date.now() - (Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : DEFAULT_HISTORY_DAYS) * 24 * 60 * 60 * 1000);

  const addresses = active.map((w) => w.address);
  const rows = await getPnlCategorySnapshotHistory(wallet, addresses, category, sinceDate.toISOString().slice(0, 10));
  const combined = combineCategorySnapshotsByDate(rows, addresses);

  const perWallet = addresses.map((address) => ({
    walletAddress: address,
    points: rows.filter((r) => r.walletAddress === address),
  }));

  res.json({ perWallet, combined });
});

// Per-token value-over-time chart data — the token-scoped counterpart to /premium/pnl-history
// above, for a member filtering the main chart down to one specific held token (fungible tokens
// only; NFTs have their own dedicated section, see CoreTierNftPnl.jsx). Unlike pnl-history/
// pnl-category-history, this is NOT a stored rollup read — it's computed fresh on every call (see
// tokenPnlService.js's own header comment for why a per-token precomputed table isn't used: an
// open-ended number of distinct tokens across every tracked wallet makes that unboundedly larger
// than the existing 2-category table). Comparable cost to /premium/pnl-snapshot's own live replay,
// short-lived in-memory cached the same way — expect this to take real time, not be instant, the
// first time a member selects a given token.
router.get("/premium/pnl-token-history", async (req, res) => {
  const { wallet, signature, timestamp, tokenAddress, days } = req.query;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Query param wallet must be a valid address" });
  }
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return res.status(400).json({ error: "Query param tokenAddress must be a valid token address" });
  }
  if (!requireAuthAndAccess(req, res, wallet, signature, timestamp)) return;
  if (!(await hasCoreAccess(wallet))) {
    return res.status(403).json({ error: "Core tier membership required" });
  }

  const active = await getCoveredWallets(wallet);
  if (active.length === 0) {
    return res.json({ perWallet: [], combined: [] });
  }

  // null here means "the wallet's entire history" — see computeTokenPnlHistory's own comment on why
  // that's derived per-wallet from its own earliest event rather than a fixed lookback like the
  // stored-rollup endpoints above use for `days=all`.
  const windowDays =
    days === "all" ? null : Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : DEFAULT_HISTORY_DAYS;

  const addresses = active.map((w) => w.address);
  const perWallet = [];
  const failed = [];
  // Sequential and independently try/caught — same reasoning as every other Core tier endpoint
  // above: a full FIFO replay per wallet is real work, and one wallet's transient failure shouldn't
  // blank out the others' already-computed results.
  for (const address of addresses) {
    const selfOwnedAddresses = addresses.filter((a) => a !== address);
    try {
      const points = await computeTokenPnlHistory(address, selfOwnedAddresses, tokenAddress, windowDays);
      perWallet.push({ walletAddress: address, points });
    } catch (err) {
      console.error(`Token PnL history computation failed for wallet ${address}:`, err);
      failed.push(address);
    }
  }
  const combined = combineTokenPnlHistory(perWallet.map((w) => w.points));
  res.json({ perWallet, combined, failed });
});

export default router;
