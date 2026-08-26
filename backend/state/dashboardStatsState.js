import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache dashboardStatsCache.js maintains — hourly snapshots of network-wide stats
// Blockscout's own API has no historical endpoint for at all (confirmed: only
// /stats/charts/market and /stats/charts/transactions exist server-side; total_addresses,
// total_blocks, average_block_time, and gas price are point-in-time-only fields on /stats with no
// chart equivalent). This is what makes those metrics chartable on the dashboard's Overview tab —
// there was no way to backfill history that was never recorded, so this starts thin the moment
// it first deploys and grows one point richer every hour from then on.
const CACHE_KEY = "dashboard-stats-history.json";

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

/** Reads `{ snapshots: [...] }`, or an empty one if never written / R2 isn't configured. */
export async function getDashboardStatsCache() {
  const r2 = getR2Client();
  if (!r2) return { snapshots: [] };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return { snapshots: Array.isArray(parsed?.snapshots) ? parsed.snapshots : [] };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { snapshots: [] }; // never written yet
    }
    console.error("⚠️  Failed to read dashboard stats history from R2:", err.message);
    return { snapshots: [] };
  }
}

/** Publishes `{ snapshots, updatedAt }`. Short cache lifetime — a rolling live time series. */
export async function setDashboardStatsCache(snapshots) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ snapshots, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
