import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache teamWalletsBalanceHistory.js maintains — a daily "combined ETN balance across
// every known Electroneum team wallet" series, powering the chart on Argus's Team Wallets tab.
// Same bucket/credentials/shape convention as this backend's other caches (e.g. teamWalletsState.js
// itself, dashboardStatsState.js).
const CACHE_KEY = "team-wallets-balance-history.json";

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

/** Reads `{ series: [{date, totalBalance}, ...] }`, or an empty one if never written / R2 isn't
 * configured. */
export async function getTeamWalletsBalanceHistoryCache() {
  const r2 = getR2Client();
  if (!r2) return { series: [] };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return { series: Array.isArray(parsed?.series) ? parsed.series : [], wallets: parsed?.wallets || {} };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { series: [] }; // never written yet
    }
    console.error("⚠️  Failed to read team wallets balance history from R2:", err.message);
    return { series: [] };
  }
}

/** Publishes `{ series, updatedAt }`. Longer cache lifetime than this backend's live/near-live
 * caches — a daily-granularity history series doesn't change meaningfully within a minute. */
export async function setTeamWalletsBalanceHistoryCache(series, wallets = {}) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ series, wallets, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  );
}
