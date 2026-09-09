// backend/utils/coreTierDemoRouter.js
//
// PUBLIC (no wallet signature, no Core tier membership) preview of Core Tier's PnL panel — for
// CoreTierPortfolio.jsx's "View Demo" button, which needs to show a visitor (including one with no
// wallet connected at all) what PnL actually looks like without them owning, connecting, or paying
// for anything. Balance History needs no equivalent here: every one of its own data sources
// (Blockscout's coin-balance-history endpoint, this app's own /api/etn-price-history, a direct
// eth_getBalance RPC read) is already public and unauthenticated — see CoreTierDemo.jsx, which
// calls those directly, same as CoreTierBalanceHistory.jsx itself does.
//
// PnL has no such public path — computeLivePnlSnapshot/getPnlSnapshotHistory are real backend
// functions normally reached only through signature+membership-gated routes. This is a SEPARATE,
// intentionally narrow public route rather than a "skip auth" flag on the real ones: it ALWAYS
// operates on the one hardcoded DEMO_WALLET_ADDRESS and NEVER accepts a wallet from the client — a
// public, unauthenticated route that computed live PnL for any address on request would be a real
// abuse vector (computeLivePnlSnapshot is a full FIFO replay + live pricing pass, the same
// expensive computation a real member's own signed request pays for). Cached in memory
// (DEMO_CACHE_TTL_MS) on top of that so repeated visits — from however many different people —
// only ever pay for that cost once per cache window, not once per request.
import express from "express";
import { computeLivePnlSnapshot, backfillPnlHistory } from "../services/pnlSnapshotService.js";
import { getPnlSnapshotHistory, combineSnapshotsByDate } from "../db/pnlSnapshots.js";

// A real wallet with rich farm/staking/token activity, chosen for a genuinely representative demo
// — deliberately never named or shown as an address/ENS name anywhere in the demo UI (CoreTierDemo.jsx/
// CoreTierDemoPage.jsx label it generically, e.g. "a real member wallet"), only its PnL/balance
// DATA is used. CoreTierDemo.jsx's own copy of this same address must stay in sync (no shared
// build step between frontend/backend in this repo, same reasoning as several other hand-synced
// constants elsewhere — e.g. pnlStatementGenerator.js's THEME).
const DEMO_WALLET_ADDRESS = "0x4bf2f40a2bf91b15c0a6c45ec2c4e1338d15df10";
const DEMO_HISTORY_DAYS = 365; // matches the real feature's own rolling-12-months convention
const DEMO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — a demo doesn't need to be second-fresh; this is what keeps a public, unauthenticated route cheap regardless of visitor count

let cache = null; // { promise, expiresAt } — promise resolves to the response payload

async function computeDemoData() {
  const snapshot = await computeLivePnlSnapshot(DEMO_WALLET_ADDRESS, []);
  // Self-owned purely for pnl_snapshots' composite key (owner_wallet, wallet_address, date) — the
  // demo wallet is never added to tracked_wallets, so the REAL daily scheduler never touches these
  // rows; this endpoint is the only thing that ever writes or reads them, on its own cache cycle.
  await backfillPnlHistory(DEMO_WALLET_ADDRESS, DEMO_WALLET_ADDRESS, [], DEMO_HISTORY_DAYS);
  const sinceDate = new Date(Date.now() - DEMO_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await getPnlSnapshotHistory(DEMO_WALLET_ADDRESS, [DEMO_WALLET_ADDRESS], sinceDate);
  const history = combineSnapshotsByDate(rows, [DEMO_WALLET_ADDRESS]);
  return { snapshot, history };
}

/** Cached, in-flight-deduplicated demo data — concurrent requests during a cache miss share ONE
 * computation rather than each triggering their own. A failed computation is never cached (so the
 * next request retries fresh instead of repeating the same error for a full hour). */
function getDemoData() {
  if (!cache || cache.expiresAt < Date.now()) {
    const promise = computeDemoData();
    const entry = { promise, expiresAt: Date.now() + DEMO_CACHE_TTL_MS };
    cache = entry;
    promise.catch(() => {
      if (cache === entry) cache = null;
    });
  }
  return cache.promise;
}

const router = express.Router();

router.get("/premium/demo/pnl", async (req, res) => {
  try {
    const { snapshot, history } = await getDemoData();
    res.json({ snapshot, history });
  } catch (err) {
    console.error("Core Tier demo PnL failed:", err);
    res.status(502).json({ error: "Couldn't load demo data right now — try again shortly" });
  }
});

export default router;
