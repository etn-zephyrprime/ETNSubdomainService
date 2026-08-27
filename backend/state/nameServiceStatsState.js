import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache nameServiceStatsCache.js maintains — proprietary .etn Name Service activity
// data Blockscout has no visibility into at all (it sees raw addresses, not this app's naming
// layer): a timestamped event history (domain registrations, activations, subname registrations,
// marketplace sales) for trend charts, plus a live snapshot of the marketplace's current floor
// price / active listing count. Same bucket/credentials as every other cache in this backend.
const CACHE_KEY = "name-service-stats.json";

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

/** Reads the last-published stats object, or null if never written yet / R2 isn't configured. */
export async function getNameServiceStatsCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read Name Service stats cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ events, floorPriceWei, activeListingsCount, lastScannedBlock, updatedAt }`. */
export async function setNameServiceStatsCache(data) {
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
