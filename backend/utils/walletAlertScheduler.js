// backend/utils/walletAlertScheduler.js
//
// Polls every distinct wallet_address that has at least one active wallet_alerts row (see
// migrations/009_alerts.sql), fetching each wallet's current state fresh from Blockscout — there's
// no existing wallet-ingestion cron this could piggyback on (ingestWalletHistory in
// pnlIngestion.js is only ever called on-demand, when a PnL statement is generated, not on a
// schedule), so this is its own, narrower poll: only wallets with active alerts, not every tracked
// wallet.
//
// Two alert types, two very different detection strategies:
//   - balance_threshold: crossing detection. last_balance_state ('above'/'below' the threshold as
//     of the last poll) is compared against the freshly-read balance's side; a notification fires
//     only on a TRANSITION that matches the alert's own configured direction, never merely for
//     "currently past it" (which would refire every single poll for as long as it stays crossed).
//   - tx_activity: v1 is scoped to NATIVE ETN transactions only (in or out), not token transfers —
//     Blockscout's /transactions and /token-transfers are two separate feeds that can both list the
//     SAME transaction hash (e.g. a swap), and correctly de-duplicating "one notification per real
//     event" across both would need real design work beyond what this alert type's brief asked for
//     ("your call on complexity for v1"). A minimum-amount filter, when set, is therefore always
//     ETN-denominated. Token-transfer activity alerts are a reasonable fast-follow, not v1 scope.
//     A per-alert last_seen_tx_hash cursor (seeded at creation to the wallet's then-current newest
//     tx — see walletAlerts.js's addWalletAlert) is what makes "new since last poll" detectable.
//
// Delivered via the Planet Zephyros Notis bot (notisLinkRouter.js) — NOT telegramNotifier.js/
// telegramLinkRouter.js, which is a different bot used for marketplace sale-alerts. See
// notisLinkRouter.js's own header comment for why these must stay separate.
import { ethers } from "ethers";
import { getPool } from "../db/pool.js";
import { getActiveTrackedWallets } from "../db/trackedWallets.js";
import { getActiveWalletAlertsByWallet, setWalletAlertBalanceState, setWalletAlertTxCursor, deactivateWalletAlerts } from "../db/walletAlerts.js";
import { getNotisLinkedChatId, sendNotisDirectMessage } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { EXPLORER_BASE_URL, getTokenMetadata } from "../services/pnlIngestion.js";

const BLOCKSCOUT_API_BASE = `${EXPLORER_BASE_URL}/api/v2`;
const CHECK_INTERVAL_MS = process.env.WALLET_ALERT_CHECK_INTERVAL_MS
  ? parseInt(process.env.WALLET_ALERT_CHECK_INTERVAL_MS, 10)
  : 10 * 60 * 1000; // mid-point of the brief's 5-15 min range
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
const FETCH_TIMEOUT_MS = 20000;
// Safety ceiling on how many newly-seen transactions get their own notification in one poll — a
// wallet with a genuine burst of activity (or an alert whose cursor somehow fell far behind)
// shouldn't be able to fire dozens of Telegram messages in one tick. Anything beyond this is still
// covered by the NEXT poll picking up where the cursor was left, nothing is silently dropped.
const MAX_TX_NOTIFICATIONS_PER_POLL = 5;

async function fetchJson(path, attempt = 0) {
  try {
    const res = await fetch(`${BLOCKSCOUT_API_BASE}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } catch (err) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return fetchJson(path, attempt + 1);
    }
    throw err;
  }
}

// Per-owner caches, scoped to ONE poll tick (module-level state would leak access changes across
// ticks) — several alerts on the same wallet, or several wallets belonging to the same owner, are
// common (a member can track up to 3 wallets and configure more than one alert per wallet), so
// this avoids re-querying the same owner's tracked-wallet list or Core tier status once per alert.
function makeTickCaches() {
  return { trackedByOwner: new Map(), accessByOwner: new Map() };
}
async function isStillTracked(caches, ownerWallet, walletAddress) {
  if (!caches.trackedByOwner.has(ownerWallet)) {
    caches.trackedByOwner.set(ownerWallet, await getActiveTrackedWallets(ownerWallet));
  }
  return caches.trackedByOwner.get(ownerWallet).some((w) => w.address === walletAddress);
}
async function ownerHasAccess(caches, ownerWallet) {
  if (!caches.accessByOwner.has(ownerWallet)) {
    caches.accessByOwner.set(ownerWallet, await hasCoreAccess(ownerWallet));
  }
  return caches.accessByOwner.get(ownerWallet);
}

async function resolveBalance(walletAddress, denomination, addressInfo, tokenBalancesPromise) {
  if (denomination === "ETN") {
    return parseFloat(ethers.formatEther(addressInfo.coin_balance || "0"));
  }
  const tokenBalances = await tokenBalancesPromise;
  const entry = (tokenBalances || []).find((b) => b.token?.address?.toLowerCase() === denomination);
  if (!entry) return 0; // never held (or balance fell to zero and Blockscout stopped listing it) — a legitimate 0
  return parseFloat(ethers.formatUnits(entry.value || "0", Number(entry.token?.decimals || 18)));
}

async function checkBalanceThresholdAlerts(alerts, walletAddress, addressInfo, tokenBalancesPromise, caches) {
  for (const alert of alerts) {
    const balance = await resolveBalance(walletAddress, alert.denomination, addressInfo, tokenBalancesPromise);
    const newState = balance >= alert.thresholdValue ? "above" : "below";
    const crossed = alert.lastBalanceState != null && newState !== alert.lastBalanceState && newState === alert.direction;

    if (crossed && (await ownerHasAccess(caches, alert.ownerWallet))) {
      const chatId = await getNotisLinkedChatId(alert.ownerWallet);
      if (chatId != null) {
        const denomLabel =
          alert.denomination === "ETN" ? "ETN" : (await getTokenMetadata(alert.denomination))?.symbol || "tokens";
        const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        await sendNotisDirectMessage(
          chatId,
          `${newState === "above" ? "📈" : "📉"} Wallet \`${shortAddr}\` balance is now ${newState} your threshold\n\n` +
            `${balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${denomLabel} (threshold: ${alert.thresholdValue} ${denomLabel})\n\n` +
            `[View wallet](${EXPLORER_BASE_URL}/address/${walletAddress}) · [Dashboard](${DASHBOARD_URL}/premium)`
        );
      }
      await setWalletAlertBalanceState(alert.id, newState, { triggered: true });
    } else {
      await setWalletAlertBalanceState(alert.id, newState, { triggered: false });
    }
  }
}

async function checkTxActivityAlerts(alerts, walletAddress, caches) {
  if (alerts.length === 0) return;

  let transactions;
  try {
    const res = await fetchJson(`/addresses/${walletAddress}/transactions`);
    transactions = res?.items || [];
  } catch (err) {
    console.warn(`⚠️  Wallet alert: transaction fetch failed for ${walletAddress}:`, err.message);
    return;
  }
  if (transactions.length === 0) return; // nothing to compare cursors against this poll

  for (const alert of alerts) {
    // Blockscout returns newest-first — walk from the top until the previously-seen hash (or the
    // end of this page) to collect exactly what's new since last poll, oldest-of-the-new-batch
    // first so notifications go out in the order the transactions actually happened.
    const newOnes = [];
    for (const tx of transactions) {
      if (tx.hash === alert.lastSeenTxHash) break;
      newOnes.push(tx);
    }
    newOnes.reverse();

    if (newOnes.length === 0) continue;

    let triggeredAny = false;
    for (const tx of newOnes.slice(0, MAX_TX_NOTIFICATIONS_PER_POLL)) {
      const valueEtn = parseFloat(ethers.formatEther(tx.value || "0"));
      if (alert.thresholdValue != null && valueEtn < alert.thresholdValue) continue; // below the configured minimum — not "activity" for this alert

      if (!(await ownerHasAccess(caches, alert.ownerWallet))) continue;
      const chatId = await getNotisLinkedChatId(alert.ownerWallet);
      if (chatId == null) continue;

      const direction = tx.to?.hash?.toLowerCase() === walletAddress ? "in" : "out";
      const counterparty = direction === "in" ? tx.from?.hash : tx.to?.hash;
      const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
      const shortCounterparty = counterparty ? `${counterparty.slice(0, 6)}...${counterparty.slice(-4)}` : "unknown";
      await sendNotisDirectMessage(
        chatId,
        `${direction === "in" ? "⬇️" : "⬆️"} Wallet \`${shortAddr}\`: ${valueEtn.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETN ${direction === "in" ? "received from" : "sent to"} \`${shortCounterparty}\`\n\n` +
          `[View transaction](${EXPLORER_BASE_URL}/tx/${tx.hash}) · [Dashboard](${DASHBOARD_URL}/premium)`
      );
      triggeredAny = true;
    }

    // Cursor always advances to this poll's newest transaction, whether or not anything actually
    // notified (e.g. every new tx was below the minimum) — otherwise a wallet with frequent small
    // activity would keep re-scanning the same already-seen transactions forever.
    await setWalletAlertTxCursor(alert.id, transactions[0].hash, { triggered: triggeredAny });
  }
}

let isRunning = false;

async function checkAllWallets() {
  if (isRunning) return;
  isRunning = true;
  try {
    const byWallet = await getActiveWalletAlertsByWallet();
    const caches = makeTickCaches();

    for (const [walletAddress, alerts] of byWallet) {
      // A wallet can be tracked by more than one different owner independently — check tracking
      // status per (owner, wallet) pair, not once for the whole address.
      const stillTracked = [];
      const orphaned = [];
      for (const alert of alerts) {
        if (await isStillTracked(caches, alert.ownerWallet, walletAddress)) stillTracked.push(alert);
        else orphaned.push(alert.id);
      }
      if (orphaned.length > 0) await deactivateWalletAlerts(orphaned);
      if (stillTracked.length === 0) continue;

      let addressInfo;
      try {
        addressInfo = await fetchJson(`/addresses/${walletAddress}`);
      } catch (err) {
        console.warn(`⚠️  Wallet alert: address fetch failed for ${walletAddress}:`, err.message);
        continue;
      }
      const tokenBalancesPromise = fetchJson(`/addresses/${walletAddress}/token-balances`)
        .then((r) => (Array.isArray(r) ? r : r?.items || []))
        .catch((err) => {
          console.warn(`⚠️  Wallet alert: token-balance fetch failed for ${walletAddress}:`, err.message);
          return [];
        });

      const balanceAlerts = stillTracked.filter((a) => a.alertType === "balance_threshold");
      const txAlerts = stillTracked.filter((a) => a.alertType === "tx_activity");

      await checkBalanceThresholdAlerts(balanceAlerts, walletAddress, addressInfo, tokenBalancesPromise, caches);
      await checkTxActivityAlerts(txAlerts, walletAddress, caches);
    }
  } catch (err) {
    console.error("⚠️  Wallet alert check failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background poller. No-op if DATABASE_URL isn't configured — same guard shape as
 * every other Postgres-backed scheduler in this backend. */
export function startWalletAlertScheduler() {
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — wallet alert scheduler disabled");
    return;
  }

  console.log(`🔔 Wallet alert scheduler started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkAllWallets();
  setInterval(checkAllWallets, CHECK_INTERVAL_MS);
}
