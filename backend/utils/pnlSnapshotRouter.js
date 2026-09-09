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
import { getIngestionState } from "../db/walletIngestionState.js";
import { computeLivePnlSnapshot, combineLivePnlSnapshots } from "../services/pnlSnapshotService.js";
import { computeLiveNftPnlSnapshot, combineLiveNftPnlSnapshots } from "../services/nftPnlService.js";
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

      if (!priorityTokens) {
        // No selection given for this wallet on this call — check whether it actually needs one
        // (cheap: just the stored ingestion cursor, no Blockscout/FIFO work) before deciding to
        // skip computing it.
        const state = await getIngestionState(address);
        if (!state?.cold_start_completed_at) {
          needsSelection.push({ walletAddress: address, availableTokens: await getSelectableTokens(address) });
          continue;
        }
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
    // frontend which ones didn't, rather than silently under-reporting the combined total.
    const combined = perWallet.length > 0 ? combineLivePnlSnapshots(perWallet) : null;
    res.json({ perWallet, combined, failed, needsSelection });
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

export default router;
