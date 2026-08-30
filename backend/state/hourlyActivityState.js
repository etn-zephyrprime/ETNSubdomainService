import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache hourlyActivityCache.js maintains — real per-UTC-hour transaction counts and
// ETN volume transferred, for the last ~8 days (a rolling window, not a growing history), plus a
// real rolling-7-day top-transactions-by-value leaderboard (see that file's header comment for
// both). Same bucket/credentials/shape-of-module as this repo's other state files.
const CACHE_KEY = "hourly-activity.json";

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

/** Reads the last-published activity object, or null if never written yet / R2 isn't configured. */
export async function getHourlyActivityCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read hourly activity cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ hours, lowScannedBlock, highScannedBlock, floorBlock, topTransactions,
 * topTransactionsSinceMs, schemaVersion, updatedAt }`. */
export async function setHourlyActivityCache(data) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
