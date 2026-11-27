// backend/utils/discordTapBot.js
//
// Discord version of the tap bot, DMs only. Discord delivers slash commands and button clicks as
// HTTP POSTs, so this is a router on the existing Express server and needs no gateway connection.
// Every request is checked against Discord's Ed25519 signature before it runs.
//
// Setup: run scripts/registerDiscordTapCommands.js, enable User Install in the Developer Portal,
// and set the app's Interactions Endpoint URL to <backend>/api/discord/tap/interactions.
// Shares the wallet, send queue, and stats with the Telegram tap bot (see tapCore.js).
import crypto from "crypto";
import { Router } from "express";
import QRCode from "qrcode";
import { ethers } from "ethers";
import { recordTap, getTapStats, getLeaderboard } from "../db/tapBotTaps.js";
import { buildBurnGif } from "./tapBurnGif.js";
import {
  EXPLORER_BASE_URL,
  MILESTONE_EVERY,
  MENU_TEXT,
  enqueue,
  fuelGauge,
  getTapContext,
  maybeFlair,
  sendTapTx,
  trackReceipt,
} from "./tapCore.js";

const DISCORD_API = "https://discord.com/api/v10";
const AUTO_DELETE_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const MENU_COMPONENTS = [
  {
    type: 1,
    components: [
      { type: 2, style: 1, label: "🔥 Tap (burn gas)", custom_id: "tap" },
      { type: 2, style: 2, label: "💰 Donate ETN", custom_id: "donate" },
    ],
  },
];

let burnGifPromise = null;
function getBurnGif() {
  burnGifPromise ??= buildBurnGif().catch((err) => {
    console.error("⚠️  Discord tap bot could not build burn GIF:", err.message);
    return null;
  });
  return burnGifPromise;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isEnabled() {
  return Boolean(
    process.env.DISCORD_TAP_APP_ID &&
      process.env.DISCORD_TAP_BOT_TOKEN &&
      process.env.DISCORD_TAP_PUBLIC_KEY &&
      process.env.TAP_WALLET_PRIVATE_KEY,
  );
}

function verifySignature(rawBody, signatureHex, timestamp) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(process.env.DISCORD_TAP_PUBLIC_KEY, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

async function discordFetch(url, init, attempt = 0) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (res.status === 429 && attempt < 3) {
    const data = await res.json().catch(() => ({}));
    await sleep((data.retry_after ?? 1) * 1000);
    return discordFetch(url, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`Discord ${init.method || "GET"} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const webhookUrl = (interactionToken) => `${DISCORD_API}/webhooks/${process.env.DISCORD_TAP_APP_ID}/${interactionToken}`;

// Replaces the bot's reply to the interaction. `files` is the full attachment list, so passing []
// removes any earlier GIF or QR code.
function editOriginal(interactionToken, { content, components = MENU_COMPONENTS, files = [] }) {
  const url = `${webhookUrl(interactionToken)}/messages/@original`;
  const payload = { content, components, attachments: files.map((file, id) => ({ id, filename: file.filename })) };
  if (files.length === 0) {
    return discordFetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((file, i) => form.append(`files[${i}]`, new Blob([file.buffer], { type: file.type }), file.filename));
  return discordFetch(url, { method: "PATCH", body: form });
}

// Discord only lets the bot edit or delete replies within 15 minutes of the interaction, so the
// 5-minute cleanup has to happen well inside that window.
function scheduleOriginalDelete(interactionToken) {
  setTimeout(() => {
    discordFetch(`${webhookUrl(interactionToken)}/messages/@original`, { method: "DELETE" }).catch((err) =>
      console.error("⚠️  Discord tap bot could not auto-delete reply:", err.message),
    );
  }, AUTO_DELETE_MS);
}

async function followUp(interactionToken, content) {
  const message = await discordFetch(`${webhookUrl(interactionToken)}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  setTimeout(() => {
    discordFetch(`${webhookUrl(interactionToken)}/messages/${message.id}`, { method: "DELETE" }).catch(() => {});
  }, AUTO_DELETE_MS);
}

async function statsText() {
  const { provider, wallet } = getTapContext();
  const [stats, leaderboard, balance] = await Promise.all([
    getTapStats().catch(() => null),
    getLeaderboard(10).catch(() => null),
    provider.getBalance(wallet.address),
  ]);

  const lines = [];
  if (stats) {
    const burned = Number(ethers.formatEther(stats.burnedWei)).toFixed(6);
    lines.push("📊 **Tap stats**", `🔥 Taps: ${stats.taps.toLocaleString()}`, `🪙 Gas burned: ${burned} ETN`);
  } else {
    lines.push("📊 **Tap stats** unavailable (no database configured)");
  }
  lines.push(`⛽ ${fuelGauge(balance)}`);
  if (leaderboard && leaderboard.length > 0) {
    lines.push("", "🏆 **Leaderboard**");
    leaderboard.forEach((row, i) => lines.push(`${i + 1}. ${row.name} — ${row.taps.toLocaleString()}`));
  }
  return lines.join("\n");
}

async function handleStats(interaction) {
  try {
    await editOriginal(interaction.token, { content: await statsText() });
  } catch (err) {
    console.error("⚠️  Discord stats failed:", err.message);
  } finally {
    scheduleOriginalDelete(interaction.token);
  }
}

async function handleTap(interaction) {
  const token = interaction.token;
  const user = interaction.user || interaction.member?.user;
  const ctx = getTapContext();
  try {
    const gif = await getBurnGif();
    const progressFiles = gif ? [{ buffer: gif, filename: "burning.gif", type: "image/gif" }] : [];
    await editOriginal(token, { content: "🔥 Burning…", files: progressFiles }).catch(() =>
      editOriginal(token, { content: "🔥 Tapping…" }),
    );

    const result = await enqueue(() => sendTapTx(ctx));
    if (!result.hash) {
      await editOriginal(token, {
        content:
          `🪫 **Out of gas!** The tap wallet has ${ethers.formatEther(result.balance)} ETN left, not enough for the next tap.\n\n` +
          "Donate ETN to keep it running.",
      });
      return;
    }

    trackReceipt(result.tx);
    const name = user?.username ? `@${user.username}` : user?.global_name || user?.username || "someone";
    let stats = null;
    try {
      await recordTap({
        txHash: result.hash,
        chatId: interaction.channel_id,
        userId: user?.id,
        username: user?.username,
        firstName: user?.global_name,
      });
      stats = await getTapStats();
    } catch (err) {
      console.error("⚠️  Discord tap bot could not record tap:", err.message);
    }

    const taps = stats ? `Tap #${stats.taps} by ${name}` : `Tapped by ${name}`;
    await editOriginal(token, {
      content:
        `🔥 **${taps}**\n[View transaction](${EXPLORER_BASE_URL}/tx/${result.hash})\n` +
        `⛽ ${fuelGauge(result.balance)}${maybeFlair()}`,
    });

    if (stats && stats.taps % MILESTONE_EVERY === 0) {
      await followUp(token, `🎉 **Milestone!** ${stats.taps.toLocaleString()} taps burned so far.`);
    }
  } catch (err) {
    console.error("⚠️  Discord tap failed:", err.message);
    await editOriginal(token, { content: "⚠️ Tap failed. Try again in a moment." }).catch(() => {});
  } finally {
    scheduleOriginalDelete(token);
  }
}

async function handleDonate(interaction) {
  const token = interaction.token;
  const address = getTapContext().wallet.address;
  try {
    const png = await QRCode.toBuffer(address, { type: "png", margin: 2, width: 512 });
    await editOriginal(token, {
      content:
        "💰 **Donate ETN to keep the taps going**\n\n" +
        `\`${address}\`\n\n` +
        "Scan the QR code or send ETN on Electroneum to the address above.\n\n" +
        "⚠️ **Disclaimer:** this is a plain ETN transfer to a wallet, not a smart contract. " +
        "Donations are not refundable or guaranteed. Send at your own risk.",
      files: [{ buffer: png, filename: "donate.png", type: "image/png" }],
    });
  } catch (err) {
    console.error("⚠️  Discord donate failed:", err.message);
  } finally {
    scheduleOriginalDelete(token);
  }
}

const router = Router();

router.post("/discord/tap/interactions", (req, res) => {
  if (!isEnabled()) return res.status(404).end();

  const signature = req.get("X-Signature-Ed25519");
  const timestamp = req.get("X-Signature-Timestamp");
  if (!req.rawBody || !signature || !timestamp || !verifySignature(req.rawBody, signature, timestamp)) {
    return res.status(401).end();
  }

  const interaction = req.body;
  const name = interaction.data?.name;
  const customId = interaction.data?.custom_id;

  if (interaction.type === 1) return res.json({ type: 1 });
  if (interaction.type === 2 && name === "tap") {
    return res.json({ type: 4, data: { content: MENU_TEXT, components: MENU_COMPONENTS } });
  }
  if (interaction.type === 2 && name === "statto") {
    res.json({ type: 5 });
    handleStats(interaction);
    return;
  }
  if (interaction.type === 3 && customId === "tap") {
    res.json({ type: 5 });
    handleTap(interaction);
    return;
  }
  if (interaction.type === 3 && customId === "donate") {
    res.json({ type: 5 });
    handleDonate(interaction);
    return;
  }
  return res.json({ type: 4, data: { content: "Unknown command.", flags: 64 } });
});

export default router;
