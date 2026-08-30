import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Scan cursor for premiumSubscriptionWatcher.js — same single-blob R2 pattern as
// dailyBlockStatsState.js/state.js. Deliberately kept in R2, not the new Postgres database this
// feature also introduces: this is scanner bookkeeping (which block have we processed up to), not
// PnL business data, and every other block-scanner in this backend already stores its cursor this
// way — no reason for this one to be the exception.
const CACHE_KEY = "premium-subscription-watcher-state.json";

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

/** Reads { lastProcessedBlock }, or null if never written yet / R2 isn't configured. */
export async function getPremiumSubscriptionWatcherState() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    console.error("⚠️  Failed to read premium subscription watcher state from R2:", err.message);
    return null;
  }
}

export async function setPremiumSubscriptionWatcherState(data) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
    })
  );
}
