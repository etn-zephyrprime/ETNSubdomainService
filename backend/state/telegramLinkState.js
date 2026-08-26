import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Backs telegramLinkRouter.js — a wallet's opt-in link to its own Telegram chat, so
// marketplaceWatcher.js can DM a domain/subname owner personally when their name sells, on top
// of (not instead of) the public "Subdomain Name Service" channel post it already makes.
//
// Single JSON blob (not one object per address the way ownedNamesCache.js etc. publish — this
// isn't a public cache, R2_PUBLIC_URL was never meant to serve it, and it's small/low-traffic
// enough that read-modify-write on every request is fine) holding two maps:
//   - pendingLinks: linkCode -> { address, createdAt } — short-lived, created when a wallet asks
//     for a code and consumed (or expires unused) once the matching /start arrives on Telegram.
//   - subscriptions: address (lowercased) -> { chatId, linkedAt } — confirmed links.
// Same bucket/credentials as every other cache/state store in this backend, own key so it can't
// collide with anything else.
const STATE_KEY = "telegram-links.json";

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
export async function getTelegramLinkState() {
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
    console.error("⚠️  Failed to read Telegram link state from R2:", err.message);
    return { ...EMPTY_STATE };
  }
}

/** Persists the full { pendingLinks, subscriptions } blob. */
export async function setTelegramLinkState(state) {
  const r2 = getR2Client();
  if (!r2) return; // no R2 configured — linking is a no-op, same as this repo's other R2-only features

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: STATE_KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: "application/json",
    })
  );
}
