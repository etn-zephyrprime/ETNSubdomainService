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
// operates on the fixed DEMO_WALLET_ADDRESSES below and NEVER accepts a wallet from the client — a
// public, unauthenticated route that computed live PnL for any address on request would be a real
// abuse vector (computeLivePnlSnapshot is a full FIFO replay + live pricing pass, the same
// expensive computation a real member's own signed request pays for). Cached in memory
// (DEMO_CACHE_TTL_MS) on top of that so repeated visits — from however many different people — only
// ever pay for that cost once per cache window, not once per request.
import express from "express";
import { computeLivePnlSnapshot, combineLivePnlSnapshots, backfillPnlHistory } from "../services/pnlSnapshotService.js";
import { getPnlSnapshotHistory, combineSnapshotsByDate } from "../db/pnlSnapshots.js";

// Three real, unrelated wallets with genuine on-chain activity — combined here the exact same way
// PortfolioDashboardSection.jsx combines a real member's own tracked wallets, so the demo actually
// LOOKS like Core Tier's real multi-wallet flagship feature instead of a single-wallet preview.
// Wallet [0] (planetzephyros.etn) was the original, single demo wallet — resolved live via
// Blockscout's ENS reverse-index (api/v2/search) before hardcoding here; CoreTierDemo.jsx's own
// copy of this same list must stay in sync (no shared build step between frontend/backend in this
// repo, same reasoning as several other hand-synced constants elsewhere — e.g.
// pnlStatementGenerator.js's THEME). Never exposed to the client as real addresses — see
// CoreTierDemo.jsx's own anonymized "Wallet 1/2/3" labels.
const DEMO_WALLET_ADDRESSES = [
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099",
  "0xd6cf49cbcf84b2cd2472a376b5f791689a0769d0",
  "0x9343e399d44e701fc26130bdbf8817d78f086867",
];
// Shared synthetic "owner" for pnl_snapshots' (owner_wallet, wallet_address, date) composite key —
// same role wallet.account plays for a real member's OWN tracked-wallet history, just fixed to
// wallet [0] here since there's no real connected member behind this route. Using wallet [0] itself
// (rather than some other sentinel) is deliberate: the ORIGINAL single-wallet version of this file
// already wrote wallet [0]'s rows self-referencing (owner_wallet = wallet_address = wallet [0]) —
// keeping that exact value means those existing rows stay valid and get picked up unchanged under
// this multi-wallet scheme, rather than orphaning a year of already-backfilled history.
const DEMO_OWNER = DEMO_WALLET_ADDRESSES[0];
const DEMO_HISTORY_DAYS = 365; // matches the real feature's own rolling-12-months convention
const DEMO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — a demo doesn't need to be second-fresh; this is what keeps a public, unauthenticated route cheap regardless of visitor count

let cache = null; // { promise, expiresAt } — promise resolves to the response payload

async function computeDemoData() {
  // Each wallet's own snapshot excludes the OTHER two from its realized P&L (a transfer between
  // them is a self-transfer, not a disposal) — same selfOwnedAddresses reasoning
  // PortfolioDashboardSection.jsx applies for a real member's own multiple tracked wallets.
  const snapshots = await Promise.all(
    DEMO_WALLET_ADDRESSES.map((addr) =>
      computeLivePnlSnapshot(addr, DEMO_WALLET_ADDRESSES.filter((a) => a !== addr))
    )
  );
  const combined = combineLivePnlSnapshots(snapshots);
  const perWallet = DEMO_WALLET_ADDRESSES.map((addr, i) => ({
    // Index only — CoreTierDemo.jsx labels these "Wallet 1/2/3"; the real address never leaves
    // this file.
    walletIndex: i,
    currentValueUsd: snapshots[i].currentValueUsd,
    unrealizedPnlUsd: snapshots[i].unrealizedPnlUsd,
    realizedPnlUsd: snapshots[i].realizedPnlUsd,
  }));

  await Promise.all(
    DEMO_WALLET_ADDRESSES.map((addr) =>
      backfillPnlHistory(DEMO_OWNER, addr, DEMO_WALLET_ADDRESSES.filter((a) => a !== addr), DEMO_HISTORY_DAYS)
    )
  );
  const sinceDate = new Date(Date.now() - DEMO_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await getPnlSnapshotHistory(DEMO_OWNER, DEMO_WALLET_ADDRESSES, sinceDate);
  const history = combineSnapshotsByDate(rows, DEMO_WALLET_ADDRESSES);

  return { snapshot: combined, perWallet, history };
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
    const { snapshot, perWallet, history } = await getDemoData();
    res.json({ snapshot, perWallet, history });
  } catch (err) {
    console.error("Core Tier demo PnL failed:", err);
    res.status(502).json({ error: "Couldn't load demo data right now — try again shortly" });
  }
});

export default router;
