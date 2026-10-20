// backend/utils/positionAlertScheduler.js
//
// Position health alerts (migrations/022_position_alerts.sql): polls every member with an active
// position_alerts row, values their liquidity and farm positions across all covered wallets — the
// same lpPositionValuation / defiPositionValuation results the Portfolio panel shows, cache and all —
// and DMs them on Telegram when:
//   - il_threshold:    a position's impermanent loss reaches -threshold%. Re-arms after recovering
//                      IL_REARM_POINTS, then can fire again (recurring);
//   - v3_out_of_range: a directly-held V3 position leaves its range (and when it's back in range);
//   - farm_multiplier: a farm position's duration multiplier passes a milestone.
//
// The decision logic is the pure evaluatePositionAlert below; everything else here is I/O.
// Same conventions as portfolioAlertScheduler.js: Core tier only (a lapsed membership pauses alerts
// in place), and state advances whether or not the DM is delivered, so linking Telegram later never
// replays a backlog.
import { getPool } from "../db/pool.js";
import { getAllActivePositionAlerts, savePositionAlertState, IL_REARM_POINTS } from "../db/positionAlerts.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getOpenDefiPositionsUsd } from "../services/defiPositionValuation.js";
import { getLiquidityPositionsUsd, fetchHeldFungibleTokens } from "../services/lpPositionValuation.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";

const CHECK_INTERVAL_MS = process.env.POSITION_ALERT_CHECK_INTERVAL_MS
  ? parseInt(process.env.POSITION_ALERT_CHECK_INTERVAL_MS, 10)
  : 10 * 60 * 1000; // position valuation is on-chain reads per position — heavier than a price check, and IL/range/multiplier move slowly
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";

export const FARM_MULTIPLIER_MILESTONES = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5];

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Legacy Telegram Markdown (createTelegramLinkRouter.js): escape what would otherwise open an entity.
const md = (s) => String(s).replace(/([_*`[])/g, "\\$1");
const pairLabel = (legs) => (legs || []).map((l) => l.symbol || "?").join("/");

/** Flattens one wallet's LP + DeFi results into the positions the alerts look at:
 * [{ key, kind, label, wallet, ilPercent, inRange, durationMultiplier }]. */
export function collectPositions(wallet, lp, defi) {
  const out = [];
  for (const p of lp?.v2Positions || []) {
    out.push({ key: `v2:${String(p.tokenAddress).toLowerCase()}:${wallet}`, kind: "v2", label: `${pairLabel(p.legs)} LP`, wallet, ilPercent: p.impermanentLoss?.percent ?? null });
  }
  for (const p of lp?.v3Positions || []) {
    out.push({ key: `v3:${p.tokenId}`, kind: "v3", label: `${pairLabel(p.legs)} V3 #${p.tokenId}`, wallet, ilPercent: p.impermanentLoss?.percent ?? null, inRange: typeof p.inRange === "boolean" ? p.inRange : null });
  }
  for (const p of defi?.positions || []) {
    if (p.kind !== "farm") continue;
    out.push({
      key: `farm:${String(p.contractAddress).toLowerCase()}:${p.farmId}:${wallet}`,
      kind: "farm",
      label: p.label || `Yield Farm #${p.farmId}`,
      wallet,
      ilPercent: p.impermanentLoss?.percent ?? null,
      durationMultiplier: p.multipliers?.durationMultiplier ?? null,
    });
  }
  return out;
}

/** Pure: given one alert ({ alertType, thresholdPct, positionState }) and the owner's current
 * positions, returns { lines, state } — the message lines to send (empty = nothing fired) and the
 * new per-position state. `complete` = every wallet's positions were read successfully; only then
 * is state for positions no longer present dropped (otherwise a failed read would forget them and
 * a later re-read would treat them as brand new). */
export function evaluatePositionAlert(alert, positions, { complete = true } = {}) {
  const prev = alert.positionState || {};
  const state = complete ? {} : { ...prev };
  const lines = [];

  for (const p of positions) {
    const before = prev[p.key];
    if (alert.alertType === "il_threshold") {
      if (p.ilPercent == null) {
        if (before) state[p.key] = before; // no reading this time — keep what we knew
        continue;
      }
      const il = Number(p.ilPercent);
      const threshold = -alert.thresholdPct;
      const rearmAt = -(alert.thresholdPct - IL_REARM_POINTS);
      const armed = before ? before.armed : true;
      if (armed && il <= threshold) {
        lines.push(`🔻 *${md(p.label)}* — impermanent loss ${il.toFixed(2)}% (alert at -${alert.thresholdPct}%) · ${shortAddr(p.wallet)}`);
        state[p.key] = { armed: false };
      } else if (!armed && il > rearmAt) {
        state[p.key] = { armed: true }; // recovered past the re-arm point — can fire again
      } else {
        state[p.key] = { armed };
      }
    } else if (alert.alertType === "v3_out_of_range") {
      if (p.kind !== "v3") continue;
      if (p.inRange == null) {
        if (before) state[p.key] = before;
        continue;
      }
      const wasInRange = before ? before.inRange : true; // first sighting: out of range is news, in range isn't
      if (wasInRange && !p.inRange) lines.push(`⚠️ *${md(p.label)}* is out of range — it's not earning fees · ${shortAddr(p.wallet)}`);
      else if (!wasInRange && p.inRange) lines.push(`✅ *${md(p.label)}* is back in range · ${shortAddr(p.wallet)}`);
      state[p.key] = { inRange: p.inRange };
    } else if (alert.alertType === "farm_multiplier") {
      if (p.kind !== "farm") continue;
      if (p.durationMultiplier == null) {
        if (before) state[p.key] = before;
        continue;
      }
      const reached = FARM_MULTIPLIER_MILESTONES.filter((m) => p.durationMultiplier >= m).pop() ?? 0;
      if (before && reached > before.milestone) {
        const isMax = reached === FARM_MULTIPLIER_MILESTONES[FARM_MULTIPLIER_MILESTONES.length - 1];
        lines.push(`⏫ *${md(p.label)}* — duration multiplier reached ${reached.toFixed(2)}×${isMax ? " (the maximum)" : ""} · ${shortAddr(p.wallet)}`);
      }
      // First sighting is recorded silently (no alert for milestones passed long ago); a drop (a top-up
      // deposit dilutes the start block) is recorded too, so climbing back re-fires — recurring.
      state[p.key] = { milestone: reached };
    }
  }
  return { lines, state };
}

const TITLES = {
  il_threshold: "Impermanent loss alert",
  v3_out_of_range: "V3 range alert",
  farm_multiplier: "Farm multiplier milestone",
};

/** All of `ownerWallet`'s positions across covered wallets. `needLp` false skips the LP read (only
 * farm alerts configured). Returns { positions, complete }. */
async function loadOwnerPositions(ownerWallet, needLp) {
  const wallets = await getCoveredWallets(ownerWallet);
  const positions = [];
  let complete = true;
  for (const w of wallets) {
    const wallet = w.address.toLowerCase();
    try {
      const [defi, lp] = await Promise.all([
        getOpenDefiPositionsUsd(wallet),
        needLp ? fetchHeldFungibleTokens(wallet).then((tokens) => getLiquidityPositionsUsd(wallet, tokens)) : null,
      ]);
      if (!defi || defi.failedCount > 0) complete = false;
      positions.push(...collectPositions(wallet, lp, defi));
    } catch (err) {
      complete = false;
      console.warn(`⚠️  Position alert: couldn't read positions for ${wallet}:`, err.message);
    }
  }
  return { positions, complete };
}

async function checkOneOwner(ownerWallet, alerts) {
  if (!(await hasCoreAccess(ownerWallet))) return; // Core tier only — a lapsed membership pauses these in place
  const needLp = alerts.some((a) => a.alertType !== "farm_multiplier");
  const { positions, complete } = await loadOwnerPositions(ownerWallet, needLp);

  for (const alert of alerts) {
    const { lines, state } = evaluatePositionAlert(alert, positions, { complete });
    if (lines.length > 0) {
      const chatId = await getNotisLinkedChatId(ownerWallet);
      if (chatId != null) {
        await sendNotisDirectMessage(chatId, `*${TITLES[alert.alertType]}*\n\n${lines.join("\n")}\n\n[Dashboard](${DASHBOARD_URL}/premium)`).catch((err) =>
          console.warn(`⚠️  Position alert: Telegram send failed for ${ownerWallet}:`, err.message)
        );
      }
    }
    await savePositionAlertState(alert.id, state, lines.length > 0);
  }
}

let isRunning = false;

async function checkAllOwners() {
  if (isRunning) return;
  isRunning = true;
  try {
    const byOwner = await getAllActivePositionAlerts();
    for (const [ownerWallet, alerts] of byOwner) {
      await checkOneOwner(ownerWallet, alerts).catch((err) => console.warn(`⚠️  Position alert check failed for ${ownerWallet}:`, err.message));
    }
  } catch (err) {
    // Includes "relation position_alerts does not exist" until migration 022 is applied.
    console.error("⚠️  Position alert check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op without DATABASE_URL, same as every other Postgres-backed scheduler. */
export function startPositionAlertScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — position alert scheduler disabled");
    return;
  }
  console.log(`🔔 Position alert scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAllOwners();
  setInterval(checkAllOwners, CHECK_INTERVAL_MS);
}
