// backend/utils/coreTierDemoRouter.js
//
// PUBLIC (no wallet signature, no Core tier membership) preview of Core Tier — for
// CoreTierPortfolio.jsx's "View Demo" button, which needs to show a visitor (including one with no
// wallet connected at all) the FULL paid experience without them owning, connecting, or paying for
// anything. Per the explicit ask: this should look exactly like it would for a real subscriber, not
// a thinned-down preview — so it now covers every read-only section a real member's Portfolio page
// does: PnL (current figures, category history, whole-portfolio history), DeFi/Liquidity positions,
// NFT PnL, and combined ETN + token holdings.
//
// Deliberately still doesn't cover: adding/removing tracked wallets, Telegram alerts, or membership
// purchase — none of those are things a real member's DATA looks like, they're WRITE actions tied
// to a real, authenticated identity (a Telegram link, a subscription, a tracked-wallet list) that a
// public demo has no business exposing or faking. CoreTierDemo.jsx shows a plain "Subscribe" CTA
// where those would be instead.
//
// This is a SEPARATE, intentionally narrow set of public routes rather than a "skip auth" flag on
// the real ones: it ALWAYS operates on the fixed DEMO_WALLET_ADDRESSES below and NEVER accepts a
// wallet from the client — a public, unauthenticated route that computed live PnL/DeFi positions
// for any address on request would be a real abuse vector (every one of these is a genuinely
// expensive computation — FIFO replay, live pricing, on-chain position valuation — the same cost a
// real member's own signed request pays for). Cached in memory (DEMO_CACHE_TTL_MS) on top of that
// so repeated visits — from however many different people — only ever pay for that cost once per
// cache window, not once per request.
//
// The real wallet addresses NEVER reach the client, in the response OR in any network request the
// client itself makes — every section here is computed server-side and returned already
// anonymized (walletIndex only). This matters beyond just what's rendered: a wallet address visible
// in a browser's network tab would defeat the anonymity requirement just as much as one printed on
// screen, so nothing about these wallets is fetched client-side (contrast CoreTierDemo.jsx's own
// Balance History section, which — same as the real CoreTierBalanceHistory.jsx — calls Blockscout
// directly client-side; that's an intentional, narrower exception carried over from this demo's
// very first version, not a new gap).
import express from "express";
import { computeLivePnlSnapshot, combineLivePnlSnapshots, backfillPnlHistory } from "../services/pnlSnapshotService.js";
import { backfillCategoryPnlHistory, CATEGORIES } from "../services/categoryPnlService.js";
import { getPnlSnapshotHistory, combineSnapshotsByDate } from "../db/pnlSnapshots.js";
import { getPnlCategorySnapshotHistory, combineCategorySnapshotsByDate } from "../db/pnlCategorySnapshots.js";
import { getOpenDefiPositionsUsd } from "../services/defiPositionValuation.js";
import { getLiquidityPositionsUsd } from "../services/lpPositionValuation.js";
import { computeLiveNftPnlSnapshot, combineLiveNftPnlSnapshots } from "../services/nftPnlService.js";
import { fetchBlockscoutJson } from "./blockscoutClient.js";
import { getDemoSnapshot } from "../state/coreTierDemoState.js";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);

// Three real, unrelated wallets with genuine on-chain activity — combined here the exact same way
// PortfolioDashboardSection.jsx combines a real member's own tracked wallets, so the demo actually
// LOOKS like Core Tier's real multi-wallet flagship feature instead of a single-wallet preview.
// Wallet [0] (planetzephyros.etn) was the original, single demo wallet — resolved live via
// Blockscout's ENS reverse-index (api/v2/search) before hardcoding here; CoreTierDemo.jsx's own
// copy of this same list must stay in sync (no shared build step between frontend/backend in this
// repo, same reasoning as several other hand-synced constants elsewhere — e.g.
// pnlStatementGenerator.js's THEME). Never exposed to the client as real addresses — see
// CoreTierDemo.jsx's own anonymized "Wallet 1/2/3" labels.
//
// Wallet [2] was swapped from 0x9343e399d44e701fc26130bdbf8817d78f086867 -- one of the most
// actively-trading wallets available, which made it the dominant cost (event count, hence FIFO
// replay + memory) of generating the demo snapshot. The new wallet is genuinely less active, so
// generateDemoSnapshot.js has meaningfully less history to walk per run. Note this means a fresh
// cold-start ingest for wallet [2] specifically on the next run (its own ingestion state starts
// from nothing) -- wallets [0]/[1] keep their existing, already-caught-up state.
//
// Every USD/quantity/balance figure the client sees is scaled down for display -- see
// CoreTierDemo.jsx's own DEMO_DISPLAY_SCALE -- but that happens client-side, on top of whatever
// this file computes/stores; the real (unscaled) figures are what's computed and persisted here.
const DEMO_WALLET_ADDRESSES = [
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099",
  "0xd6cf49cbcf84b2cd2472a376b5f791689a0769d0",
  "0xc92e01d795313ad4f93c6d35ce764ce3dad6d0ee",
];
// Shared synthetic "owner" for pnl_snapshots'/pnl_category_snapshots' (owner_wallet, wallet_address,
// ..., date) composite keys — same role wallet.account plays for a real member's OWN tracked-wallet
// history, just fixed to wallet [0] here since there's no real connected member behind this route.
// Using wallet [0] itself (rather than some other sentinel) is deliberate: the ORIGINAL
// single-wallet version of this file already wrote wallet [0]'s pnl_snapshots rows self-referencing
// (owner_wallet = wallet_address = wallet [0]) — keeping that exact value means those existing rows
// stay valid and get picked up unchanged under this multi-wallet scheme, rather than orphaning a
// year of already-backfilled history.
const DEMO_OWNER = DEMO_WALLET_ADDRESSES[0];
const DEMO_HISTORY_DAYS = 365; // matches the real feature's own rolling-12-months convention
const DEMO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — a demo doesn't need to be second-fresh; this is what keeps a public, unauthenticated route cheap regardless of visitor count

let cache = null; // { promise, expiresAt } — promise resolves to the response payload

/** Every fungible (non-NFT) token balance across all DEMO_WALLET_ADDRESSES, merged by token
 * address, plus the combined native ETN balance — the server-side equivalent of
 * useCombinedPortfolio.js's own client-side merge (same reasoning: kept off the client entirely so
 * a real wallet address never appears in a browser network request — see this file's own header
 * comment). Returns `{ totalCoinBalance (string, wei), tokens: [{tokenAddress, symbol, name,
 * decimals, rawBalance, heldByCount}] }`. A single wallet's lookup failing is logged and treated as
 * "holds nothing" rather than failing the whole combined view. */
async function getCombinedHoldings() {
  const perWallet = await Promise.all(
    DEMO_WALLET_ADDRESSES.map(async (addr) => {
      try {
        const [info, balancesRaw] = await Promise.all([
          fetchBlockscoutJson(`/addresses/${addr}`),
          fetchBlockscoutJson(`/addresses/${addr}/token-balances`),
        ]);
        const balances = Array.isArray(balancesRaw) ? balancesRaw : balancesRaw?.items || [];
        return { coinBalance: info?.coin_balance || "0", balances };
      } catch (err) {
        console.warn(`⚠️  Core Tier demo: couldn't load holdings for a demo wallet:`, err.message);
        return { coinBalance: "0", balances: [] };
      }
    })
  );

  let totalCoinBalance = 0n;
  const tokensByAddress = new Map();
  for (const w of perWallet) {
    totalCoinBalance += BigInt(w.coinBalance || 0);
    for (const tb of w.balances) {
      const tokenAddr = tb.token?.address?.toLowerCase();
      if (!tokenAddr || NFT_TOKEN_TYPES.has(tb.token?.type)) continue;
      const value = BigInt(tb.value || 0);
      const existing = tokensByAddress.get(tokenAddr);
      if (existing) {
        existing.rawBalance = (BigInt(existing.rawBalance) + value).toString();
        existing.heldByCount += 1;
      } else {
        tokensByAddress.set(tokenAddr, {
          tokenAddress: tokenAddr,
          symbol: tb.token?.symbol || null,
          name: tb.token?.name || null,
          decimals: tb.token?.decimals ?? 18,
          rawBalance: value.toString(),
          heldByCount: 1,
        });
      }
    }
  }

  return { totalCoinBalance: totalCoinBalance.toString(), tokens: [...tokensByAddress.values()], perWalletTokens: perWallet.map((w) => w.balances) };
}

// Exported so generateDemoSnapshot.js can run this same computation once, offline, rather than the
// router paying for it live -- see coreTierDemoState.js's own header comment.
export async function computeDemoData() {
  // Each wallet's own snapshot excludes the OTHER two from its realized P&L (a transfer between
  // them is a self-transfer, not a disposal) — same selfOwnedAddresses reasoning
  // PortfolioDashboardSection.jsx applies for a real member's own multiple tracked wallets. Same
  // pattern repeated for DeFi/liquidity/NFT below — every section that needs "the wallet's own
  // history minus its sibling demo wallets" uses the identical selfOwned filter.
  const selfOwned = (addr) => DEMO_WALLET_ADDRESSES.filter((a) => a !== addr);

  // Deliberately one wallet at a time here, NOT Promise.all'd across all 3 demo wallets — each
  // wallet's full transfer/swap/DeFi history plus its FIFO replay is genuinely large in memory, and
  // running all 3 wallets' worth of that concurrently was blowing past this process's heap limit
  // (confirmed: an out-of-memory crash running this exact computation). This has no HTTP request
  // deadline to race — generateDemoSnapshot.js calls it offline — so trading wall-clock time for a
  // ~3x cut in peak memory is the right call. The 3 KINDS of work for a single wallet (snapshot,
  // DeFi positions, NFT PnL) still run concurrently with each other; only the per-wallet loop below
  // was ever the source of the actual blowup.
  const snapshots = [];
  const defiResults = [];
  const nftSnapshots = [];
  for (const addr of DEMO_WALLET_ADDRESSES) {
    const [snapshot, defiResult, nftSnapshot] = await Promise.all([
      computeLivePnlSnapshot(addr, selfOwned(addr)),
      getOpenDefiPositionsUsd(addr).catch((err) => {
        console.warn(`⚠️  Core Tier demo: DeFi position lookup failed for a demo wallet:`, err.message);
        return { positions: [], totalUsd: null, hasUnpriced: true };
      }),
      computeLiveNftPnlSnapshot(addr, selfOwned(addr)).catch((err) => {
        console.warn(`⚠️  Core Tier demo: NFT PnL failed for a demo wallet:`, err.message);
        return null;
      }),
    ]);
    snapshots.push(snapshot);
    defiResults.push(defiResult);
    nftSnapshots.push(nftSnapshot);
  }
  const combinedHoldings = await getCombinedHoldings();

  const combined = combineLivePnlSnapshots(snapshots);
  const perWallet = DEMO_WALLET_ADDRESSES.map((addr, i) => ({
    // Index only — CoreTierDemo.jsx labels these "Wallet 1/2/3"; the real address never leaves
    // this file.
    walletIndex: i,
    currentValueUsd: snapshots[i].currentValueUsd,
    unrealizedPnlUsd: snapshots[i].unrealizedPnlUsd,
    realizedPnlUsd: snapshots[i].realizedPnlUsd,
  }));

  // Liquidity positions need each wallet's own fungible-token candidate list (the V2-LP probe
  // target set) — already fetched above via getCombinedHoldings, reused here rather than a second
  // Blockscout round-trip per wallet. Sequential across wallets for the same reason as the loop
  // above — this does real on-chain reads per candidate token per wallet, no need to pile 3
  // wallets' worth of that up in memory at once.
  const lpResults = [];
  for (let i = 0; i < DEMO_WALLET_ADDRESSES.length; i++) {
    const addr = DEMO_WALLET_ADDRESSES[i];
    const candidateTokens = (combinedHoldings.perWalletTokens[i] || [])
      .filter((tb) => tb.token?.address && !NFT_TOKEN_TYPES.has(tb.token?.type))
      .map((tb) => ({ address: tb.token.address, decimals: tb.token.decimals, rawBalance: tb.value }));
    const result = await getLiquidityPositionsUsd(addr, candidateTokens).catch((err) => {
      console.warn(`⚠️  Core Tier demo: liquidity position lookup failed for a demo wallet:`, err.message);
      return { v2Positions: [], v3Positions: [], totalUsd: null, hasUnpriced: true, lpTokenAddresses: new Set() };
    });
    lpResults.push(result);
  }

  const combineUsdTotals = (results) => {
    let totalUsd = null;
    let hasUnpriced = false;
    for (const r of results) {
      if (r.hasUnpriced) hasUnpriced = true;
      if (r.totalUsd != null) totalUsd = (totalUsd ?? 0) + Number(r.totalUsd);
    }
    return { totalUsd, hasUnpriced };
  };
  const defiPositions = { ...combineUsdTotals(defiResults), positions: defiResults.flatMap((r) => r.positions) };
  const liquidityPositions = {
    ...combineUsdTotals(lpResults),
    v2Positions: lpResults.flatMap((r) => r.v2Positions),
    v3Positions: lpResults.flatMap((r) => r.v3Positions),
  };
  const nftPnl = combineLiveNftPnlSnapshots(nftSnapshots.filter(Boolean));

  // Whole-portfolio + per-category history — one replayFifoCheckpoints pass per wallet either way
  // (see backfillPnlHistory/backfillCategoryPnlHistory's own comments). One wallet at a time (was
  // previously fanned out 6-way — 3 wallets × {whole-portfolio, per-category} — via Promise.all,
  // which is what actually blew the heap). The two backfills FOR that one wallet are now also
  // sequential rather than concurrent, deliberately: backfillPnlHistory's own buildEventsForWallet
  // result is passed straight into backfillCategoryPnlHistory (its `precomputed` param — see that
  // function's own comment), so the two no longer each hold their own independent copy of this
  // wallet's entire event/DeFi-activity history at the same time.
  for (const addr of DEMO_WALLET_ADDRESSES) {
    const built = await backfillPnlHistory(DEMO_OWNER, addr, selfOwned(addr), DEMO_HISTORY_DAYS);
    await backfillCategoryPnlHistory(DEMO_OWNER, addr, selfOwned(addr), DEMO_HISTORY_DAYS, built);
  }
  const sinceDate = new Date(Date.now() - DEMO_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const historyRows = await getPnlSnapshotHistory(DEMO_OWNER, DEMO_WALLET_ADDRESSES, sinceDate);
  const history = combineSnapshotsByDate(historyRows, DEMO_WALLET_ADDRESSES);

  const categoryHistory = {};
  for (const category of Object.values(CATEGORIES)) {
    const rows = await getPnlCategorySnapshotHistory(DEMO_OWNER, DEMO_WALLET_ADDRESSES, category, sinceDate);
    categoryHistory[category] = combineCategorySnapshotsByDate(rows, DEMO_WALLET_ADDRESSES);
  }

  return {
    snapshot: combined,
    perWallet,
    history,
    categoryHistory,
    defiPositions,
    liquidityPositions,
    nftPnl,
    combinedHoldings: {
      totalCoinBalance: combinedHoldings.totalCoinBalance,
      tokens: combinedHoldings.tokens,
    },
  };
}

/** LIVE-COMPUTE FALLBACK, only used when generateDemoSnapshot.js hasn't been run yet (R2 not
 * configured, or a fresh deploy before anyone's generated a snapshot) — see the route handler
 * below, which always prefers the persisted snapshot when one exists. Cached, in-flight-
 * deduplicated: concurrent requests during a cache miss share ONE computation rather than each
 * triggering their own. A failed computation is never cached (so the next request retries fresh
 * instead of repeating the same error for a full hour). */
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
    // Preferred path: a static, already-anonymized snapshot generated ahead of time by
    // generateDemoSnapshot.js (see coreTierDemoState.js) — O(1), no live Blockscout/RPC/valuation
    // work per request. Falls back to a live (unscaled) computation only if no snapshot has ever
    // been persisted, so the demo still works before that script's first run.
    const stored = await getDemoSnapshot();
    if (stored) {
      res.json({ ...stored.data, generatedAt: stored.generatedAt });
      return;
    }
    res.json(await getDemoData());
  } catch (err) {
    console.error("Core Tier demo PnL failed:", err);
    res.status(502).json({ error: "Couldn't load demo data right now — try again shortly" });
  }
});

export default router;
