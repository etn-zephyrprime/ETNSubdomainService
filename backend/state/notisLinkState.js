import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Backs notisLinkRouter.js — a wallet's opt-in link to its own Telegram chat with the Planet
// Zephyros Notis bot, so walletAlertScheduler.js/tokenPriceAlertScheduler.js can DM Core tier
// alerts. Same shape as telegramLinkState.js (which backs the DIFFERENT ETN Subdomain Service
// bot) — deliberately its own R2 key, not shared: the two bots' link tables must never collide,
// since a chatId under one bot's token is meaningless to the other's.
const STATE_KEY = "notis-telegram-links.json";

let cachedR2Client = null;
function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return cachedR2Client;
}

const EMPTY_STATE = { pendingLinks: {}, subscriptions: {} };

/** Reads the current { pendingLinks, subscriptions } blob, or an empty one if never written. */
export async function getNotisLinkState() {
  const r2 = getR2Client();
  if (!r2) return { ...EMPTY_STATE };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      pendingLinks: parsed?.pendingLinks || {},
      subscriptions: parsed?.subscriptions || {},
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { ...EMPTY_STATE }; // never written yet
    }
    console.error("⚠️  Failed to read Notis Telegram link state from R2:", err.message);
    return { ...EMPTY_STATE };
  }
}

/** Persists the full { pendingLinks, subscriptions } blob. */
export async function setNotisLinkState(state) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: STATE_KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: "application/json",
    })
  );
}
