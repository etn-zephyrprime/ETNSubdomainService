// backend/utils/argusAlertsScheduler.js
//
// The owner's Argus Telegram alerts, posted to the Planet Zephyros group by the "Zephyros" bot
// (@PlanetZephyrosNotisBot, coreClashTelegram.js) — the same group and General topic as the CORE
// buy/sell/burn alerts, not DMs (owner's choice):
//   1. token liquidity locks expiring in 30 days / 7 days / 1 day, and expired
//   2. team-wallet movements of 1M+ ETN, and the team's combined balance moving 1%+
//   3. validators moving 100k+ ETN
//   4. an exchange (CEX label) moving 10M+ ETN
//   5. a daily ETN Bridge overview until the 31 Jan 2027 deadline
//   6. a weekly Hyperlane Bridge net-flow summary (7 days + 12 months, per chain)
// The rules are pure (services/argusAlertRules.js); this file loads the data Argus already
// publishes to R2, runs them every TICK_MS, sends what they return, and saves their state to R2
// (argus-alerts-state.json) so a restart never repeats an alert. Exchange balances are read live
// from Blockscout every CEX_POLL_MS — the published CEX file only refreshes daily, too slow for a
// movement alert.
//
// On by default once the Zephyros group bot is configured; ARGUS_ALERTS_ENABLED=false turns it off.
import { ethers } from "ethers";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createRpcProvider } from "./rpcProvider.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { sendZephyrosMessage, sendZephyrosPhoto, visibleLength, footerVisibleLength, zephyrosBotConfigured, GENERAL_THREAD_ID } from "./coreClashTelegram.js";
import { getTeamWalletsCache } from "../state/teamWalletsState.js";
import { getValidatorWalletsCache } from "../state/validatorWalletsState.js";
import { getTokenLocksCache } from "../state/tokenLocksState.js";
import { getEtnBridgeData } from "../state/etnBridgeState.js";
import { getHyperlaneBridgeData } from "../state/hyperlaneBridgeState.js";
import { getCexBalanceHistoryCache } from "../state/cexBalanceHistoryState.js";
import { tokenLockAlerts, teamWalletAlerts, validatorAlerts, cexAlerts, cexMoveMessage, bridgeDailyAlert, hyperlaneWeeklyAlert, mdToHtml, md, WALLET_REF_RE } from "../services/argusAlertRules.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";
import { REVERSE_REGISTRAR_ADDRESS } from "./coreClashConfig.js";

const num = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);
const TICK_MS = num("ARGUS_ALERTS_INTERVAL_MS", 10 * 60 * 1000);
const CEX_POLL_MS = num("ARGUS_ALERTS_CEX_POLL_MS", 30 * 60 * 1000);
const DIGEST_HOUR_UTC = num("ARGUS_ALERTS_DIGEST_HOUR_UTC", 9);
const EXPLORER = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const STATE_KEY = "argus-alerts-state.json";
const NAME_TTL_MS = 6 * 60 * 60 * 1000; // re-check a wallet's ENS name at most every 6 hours
// The Argus logo on every alert — a still of the dashboard header (scripts/renderArgusLogo.js).
// Uploaded once; Telegram's file_id is kept in the alert state and reused after that.
const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "ArgusLogo.png");
const CAPTION_LIMIT = 1024;
const MAX_MESSAGE = 3600; // under Telegram's 4,096-character limit, leaving room for the group footer

let r2 = null;
function getR2() {
  if (r2) return r2;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  r2 = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  return r2;
}

/** Saved alert state, or {} if never written. Throws on any other failure (so the tick skips
 * rather than starting over and re-alerting). */
async function loadState() {
  try {
    const res = await getR2().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return {};
    throw err;
  }
}
async function saveState(state) {
  await getR2().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY, Body: JSON.stringify(state), ContentType: "application/json", CacheControl: "no-store" }));
}

/** Splits a long message on line breaks to stay under Telegram's limit. */
function chunks(text) {
  if (text.length <= MAX_MESSAGE) return [text];
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > MAX_MESSAGE) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function tokenSymbols(provider, addresses, known = {}) {
  const symbols = { ...known };
  for (const a of addresses) {
    if (symbols[a]) continue;
    symbols[a] = await new ethers.Contract(a, ["function symbol() view returns (string)"], provider).symbol().catch(() => null);
  }
  return symbols;
}

// address -> exchange label, refreshed whenever the CEX list is read: any alert naming one of these
// wallets shows the exchange's tag instead of an address (resolveWalletNames).
const cexLabels = new Map();

async function cexAddressList() {
  const cex = await getCexBalanceHistoryCache().catch(() => null);
  const list = (cex?.addresses || []).map((a) => ({ address: a.address.toLowerCase(), label: a.label }));
  if (list.length) {
    cexLabels.clear();
    for (const a of list) cexLabels.set(a.address, a.label);
  }
  return list;
}

async function cexBalances() {
  const list = await cexAddressList();
  const out = [];
  for (const a of list) {
    const res = await fetch(`${EXPLORER}/addresses/${a.address}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Blockscout ${a.address} returned ${res.status}`); // all or nothing: a partial read would look like a move
    const info = await res.json();
    out.push({ ...a, etn: Number(ethers.formatEther(info.coin_balance || "0")) });
  }
  return out;
}

const CEX_TX_PAGES = 5; // per address, 50 transactions a page

/** Native ETN transfers in or out of a move's changed addresses since its window began — the
 * transfers behind an exchange alert. [{ hash, from, to, etn }], or null if the lookup failed. */
export async function cexTransfers(move) {
  const seen = new Map();
  for (const { address } of move.moved) {
    let params = "";
    for (let page = 0; page < CEX_TX_PAGES; page++) {
      const res = await fetch(`${EXPLORER}/addresses/${address}/transactions${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Blockscout ${address} transactions returned ${res.status}`);
      const data = await res.json();
      let older = false;
      for (const t of data.items || []) {
        if (Date.parse(t.timestamp) < move.sinceMs) {
          older = true;
          break;
        }
        if (t.status !== "ok" || !t.to?.hash || BigInt(t.value || 0) === 0n) continue;
        seen.set(t.hash, { hash: t.hash, from: t.from.hash.toLowerCase(), to: t.to.hash.toLowerCase(), etn: Number(ethers.formatEther(t.value)) });
      }
      if (older || !data.next_page_params) break;
      params = `?${new URLSearchParams(data.next_page_params)}`;
    }
  }
  return [...seen.values()];
}

export function startArgusAlertsScheduler() {
  if (process.env.ARGUS_ALERTS_ENABLED === "false") {
    console.log("ℹ️  ARGUS_ALERTS_ENABLED=false — Argus alerts disabled");
    return;
  }
  if (!getR2()) {
    console.log("ℹ️  R2 not configured — Argus alerts disabled");
    return;
  }
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros group bot not configured (COREBOT_ZEPHYROS_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — Argus alerts disabled");
    return;
  }
  const provider = createRpcProvider();
  // Same resolver as the CORE burn / NFT watchers: verified primary .etn name, else a name the wallet
  // owns (Blockscout), else the shortened address.
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);
  const names = new Map(); // address -> { name, at }
  const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  /** Swaps every wallet marker (walletRef) in a message for that wallet's display name. */
  async function resolveWalletNames(text) {
    if (cexLabels.size === 0) await cexAddressList();
    const addrs = [...new Set([...text.matchAll(WALLET_REF_RE)].map((m) => m[1]))].filter((a) => !cexLabels.has(a));
    for (const a of addrs) {
      const hit = names.get(a);
      if (hit && Date.now() - hit.at < NAME_TTL_MS) continue;
      names.set(a, { name: await resolveDisplayName(a).catch(() => shortAddr(a)), at: Date.now() });
    }
    // An exchange's own address shows as its tag (e.g. KuCoin), not a name or address.
    return text.replace(WALLET_REF_RE, (_, a) => md(cexLabels.get(a) || names.get(a)?.name || shortAddr(a)));
  }
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      let state = await loadState();
      const now = Date.now();
      const messages = [];
      const run = async (name, fn) => {
        try {
          const r = await fn(state);
          if (r) {
            state = r.state;
            messages.push(...r.messages);
          }
        } catch (err) {
          console.warn(`⚠️  Argus alerts: ${name} check failed:`, err.message); // that rule waits for next tick
        }
      };

      await run("token locks", async (s) => {
        const locks = (await getTokenLocksCache())?.locksByAddress;
        if (!locks) return null;
        const symbols = await tokenSymbols(provider, Object.keys(locks).filter((a) => locks[a]?.latestUnlockAt), s.symbols);
        const r = tokenLockAlerts(locks, symbols, s, now);
        return { ...r, state: { ...r.state, symbols } };
      });
      await run("team wallets", async (s) => teamWalletAlerts(await getTeamWalletsCache(), s));
      await run("validators", async (s) => {
        const v = await getValidatorWalletsCache();
        return v ? validatorAlerts(v, s) : null;
      });
      await run("CEX balances", async (s) => {
        if (s.cexPolledAt && now - Date.parse(s.cexPolledAt) < CEX_POLL_MS) return null;
        const r = cexAlerts(await cexBalances(), s, { nowMs: now });
        // Each move gets the transfers behind it (From / To / link); if that lookup fails it still
        // goes out, with the per-address balance changes instead.
        const messages = [];
        for (const move of r.moves) {
          const transfers = await cexTransfers(move).catch((err) => {
            console.warn(`⚠️  Argus alerts: ${move.label} transfer lookup failed:`, err.message);
            return null;
          });
          messages.push(cexMoveMessage(move, transfers));
        }
        return { messages, state: { ...r.state, cexPolledAt: new Date(now).toISOString() } };
      });
      await run("ETN bridge", async (s) => bridgeDailyAlert(await getEtnBridgeData(), s, now, { hourUtc: DIGEST_HOUR_UTC }));
      await run("Hyperlane", async (s) => hyperlaneWeeklyAlert(await getHyperlaneBridgeData(), s, now, { weekday: 1, hourUtc: DIGEST_HOUR_UTC }));

      // State first: a failed send then can't be re-sent on the next tick as a duplicate.
      await saveState(state);

      // Each alert goes out as the Argus logo with the alert as its caption. Telegram caps captions at
      // 1,024 characters, so a longer one (a big lock list, a long weekly summary) goes as the logo
      // captioned with its title line, followed by the full alert as a message.
      let logoId = state.logoFileId || null;
      const sendWithLogo = async (html) => {
        const fits = visibleLength(html) + footerVisibleLength() <= CAPTION_LIMIT;
        const caption = fits ? html : html.split("\n")[0];
        const result = await sendZephyrosPhoto(logoId || readFileSync(LOGO_PATH), caption, { threadId: GENERAL_THREAD_ID, footer: fits, filename: "ArgusLogo.png" });
        const sizes = result?.photo || [];
        if (!logoId && sizes.length) logoId = sizes[sizes.length - 1].file_id;
        if (!fits) await sendZephyrosMessage(html, { threadId: GENERAL_THREAD_ID });
      };
      for (const raw of messages) {
        const m = await resolveWalletNames(raw);
        for (const part of chunks(m)) {
          await sendWithLogo(mdToHtml(part)).catch(async (err) => {
            console.warn("⚠️  Argus alerts: photo send failed, sending as text:", err.message);
            await sendZephyrosMessage(mdToHtml(part), { threadId: GENERAL_THREAD_ID }).catch((e) => console.warn("⚠️  Argus alerts: Telegram send failed:", e.message));
          });
        }
      }
      if (logoId && logoId !== state.logoFileId) await saveState({ ...state, logoFileId: logoId });
      if (messages.length) console.log(`📣 Argus alerts: sent ${messages.length} alert(s)`);
    } catch (err) {
      console.error("⚠️  Argus alerts tick failed:", err.message);
    } finally {
      running = false;
    }
  }

  console.log(`📣 Argus alerts started (every ${TICK_MS / 60000} min; CEX balances every ${CEX_POLL_MS / 60000} min; bridge daily + Hyperlane Mondays at ${DIGEST_HOUR_UTC}:00 UTC)`);
  tick();
  setInterval(tick, TICK_MS);
}
