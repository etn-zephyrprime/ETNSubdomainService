// backend/utils/pnlSnapshotScheduler.js
//
// Writes one pnl_snapshots row per actively-tracked wallet per UTC calendar day — the cheap
// daily-rollup backing for the value-over-time chart on Core tier's "ongoing dashboard PnL"
// feature (pnlSnapshotService.js does the actual, always-live "right now" computation this
// schedules a lightweight historical record of). There's no existing wallet-ingestion or
// PnL-specific cron this could piggyback on — confirmed the same way walletAlertScheduler.js's own
// header comment already did: ingestWalletHistory only ever runs on-demand (a Statement generation,
// or pnlSnapshotService's own live computation), never on a schedule. So, same as that scheduler,
// this is its own dedicated poll.
//
// Ticks frequently (CHECK_INTERVAL_MS) but only actually computes+writes once a UTC day has passed
// since a given (owner, wallet)'s last snapshot — same "cheap DB check for anyone not yet due"
// shape as portfolioDigestScheduler.js.
import { getAllActiveTrackedWalletPairs, upsertPnlSnapshot } from "../db/pnlSnapshots.js";
import { getPool, query } from "../db/pool.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { computeLivePnlSnapshot, backfillPnlHistory } from "../services/pnlSnapshotService.js";
import { backfillCategoryPnlHistory } from "../services/categoryPnlService.js";

// How far back the value-over-time chart's retroactive backfill (see backfillPnlHistory's own
// comment) reaches — matches CoreTierBalanceHistory.jsx's / pnlSnapshotRouter.js's own "rolling 12
// months" convention for this dashboard.
const BACKFILL_WINDOW_DAYS = 365;

const CHECK_INTERVAL_MS = process.env.PNL_SNAPSHOT_CHECK_INTERVAL_MS
  ? parseInt(process.env.PNL_SNAPSHOT_CHECK_INTERVAL_MS, 10)
  : 20 * 60 * 1000; // same order as portfolioDigestScheduler.js's own check cadence
const SNAPSHOT_HOUR_UTC = process.env.PNL_SNAPSHOT_HOUR_UTC ? parseInt(process.env.PNL_SNAPSHOT_HOUR_UTC, 10) : 13;

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}
function toDateString(d) {
  if (!d) return null;
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

async function alreadySnapshottedToday(ownerWallet, walletAddress, today) {
  const res = await query(
    `SELECT 1 FROM pnl_snapshots WHERE owner_wallet = $1 AND wallet_address = $2 AND snapshot_date = $3`,
    [ownerWallet, walletAddress, today]
  );
  return (res?.rows?.length || 0) > 0;
}

let isRunning = false;

async function checkAllWallets() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    if (now.getUTCHours() < SNAPSHOT_HOUR_UTC) return; // not yet today's write window
    const today = todayUtcDateString();

    const pairs = await getAllActiveTrackedWalletPairs();
    if (pairs.length === 0) return;

    // Grouped by owner so each wallet's snapshot can pass the owner's OTHER tracked wallets as
    // selfOwnedAddresses (see pnlSnapshotService.js's own comment on why) — one grouping pass,
    // not a re-query per wallet.
    const walletsByOwner = new Map();
    for (const { owner_wallet, wallet_address } of pairs) {
      if (!walletsByOwner.has(owner_wallet)) walletsByOwner.set(owner_wallet, []);
      walletsByOwner.get(owner_wallet).push(wallet_address);
    }

    // Sequential, not parallel — a full FIFO replay + live pricing per wallet is real work; running
    // every tracked wallet in this backend at once would spike RPC/pricing load all at the same
    // moment for no benefit (this only needs to finish once, sometime today, not instantly).
    for (const [ownerWallet, wallets] of walletsByOwner) {
      if (!(await hasCoreAccess(ownerWallet))) continue; // premium-only, same as every other Core tier feature

      for (const walletAddress of wallets) {
        if (await alreadySnapshottedToday(ownerWallet, walletAddress, today)) continue;

        try {
          const selfOwnedAddresses = wallets.filter((a) => a !== walletAddress);
          const snapshot = await computeLivePnlSnapshot(walletAddress, selfOwnedAddresses);
          await upsertPnlSnapshot(ownerWallet, walletAddress, today, {
            totalValueUsd: snapshot.currentValueUsd,
            realizedPnlUsd: snapshot.realizedPnlUsd,
            unrealizedPnlUsd: snapshot.unrealizedPnlUsd,
          });
        } catch (err) {
          console.warn(`⚠️  PnL snapshot failed for ${ownerWallet}'s wallet ${walletAddress}:`, err.message);
          continue; // no point attempting the backfill below off a wallet whose "today" figure just failed
        }

        // Retroactive value-over-time history — see backfillPnlHistory's own comment. Idempotent
        // (returns immediately once a wallet's window is fully filled), so calling this every day
        // right after writing "today" costs almost nothing once it's caught up; it only does real
        // work the first handful of times for a given wallet.
        const selfOwnedAddresses = wallets.filter((a) => a !== walletAddress);
        // Passed into backfillCategoryPnlHistory below (its `precomputed` param) when non-null, so
        // the two don't each independently fetch and hold this wallet's entire event/DeFi-activity
        // history at once — see backfillPnlHistory's own comment.
        let built = null;
        try {
          built = await backfillPnlHistory(ownerWallet, walletAddress, selfOwnedAddresses, BACKFILL_WINDOW_DAYS);
        } catch (err) {
          console.warn(`⚠️  PnL history backfill failed for ${ownerWallet}'s wallet ${walletAddress}:`, err.message);
        }

        // Liquidity Positions / Staking & Yield Farms category history — see
        // categoryPnlService.js's own comment. Covers today too (unlike the backfill above), so
        // this never becomes a full no-op even once a wallet is fully caught up; the day-by-day
        // idempotency is handled inside backfillCategoryPnlHistory itself.
        try {
          await backfillCategoryPnlHistory(ownerWallet, walletAddress, selfOwnedAddresses, BACKFILL_WINDOW_DAYS, built);
        } catch (err) {
          console.warn(`⚠️  Category PnL history backfill failed for ${ownerWallet}'s wallet ${walletAddress}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("⚠️  PnL snapshot check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startPnlSnapshotScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — PnL snapshot scheduler disabled");
    return;
  }

  console.log(`📈 PnL snapshot scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s, writes at ${SNAPSHOT_HOUR_UTC}:00 UTC)`);
  checkAllWallets();
  setInterval(checkAllWallets, CHECK_INTERVAL_MS);
}
