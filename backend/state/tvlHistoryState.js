import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache tvlHistory.js maintains — total value locked in ElectroSwap's pools over time,
// backing the Overview tab's TVL tile. Same single-blob R2 pattern as every other cache in this
// backend (dashboardStatsState.js etc.).
const CACHE_KEY = "tvl-history.json";

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

/** Reads `{ points, backfill }`, or an empty history if never written / R2 isn't configured.
 * `points`: [{ t, tvlUsd, pools?, src? }] (see tvlHistory.js); `backfill`: { source, fetchedAt } once
 * the one-time historical backfill has run. */
export async function getTvlHistory() {
  const r2 = getR2Client();
  if (!r2) return { points: [], backfill: null };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return { points: Array.isArray(parsed?.points) ? parsed.points : [], backfill: parsed?.backfill ?? null };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { points: [], backfill: null }; // never written yet
    }
    console.error("⚠️  Failed to read TVL history from R2:", err.message);
    return { points: [], backfill: null };
  }
}

/** Publishes `{ points, backfill, updatedAt }`. Short cache lifetime — a live time series. */
export async function setTvlHistory(points, backfill) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ points, backfill: backfill ?? null, updatedAt: new Date().toISOString() }),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
