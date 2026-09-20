import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache etnBridge.js maintains — how much legacy-chain ETN has migrated across the ETNBridge
// contract over time, backing the free dashboard's "ETN Bridge" tab. Same single-blob R2 pattern as every
// other cache in this backend.
const CACHE_KEY = "etn-bridge.json";

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

const EMPTY = () => ({ points: [], backfill: null, current: null, top7d: null });

/** Reads `{ points, backfill, current, top7d }`, or an empty one if never written / R2 isn't configured. */
export async function getEtnBridgeData() {
  const r2 = getR2Client();
  if (!r2) return EMPTY();

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      points: Array.isArray(parsed?.points) ? parsed.points : [],
      backfill: parsed?.backfill ?? null,
      current: parsed?.current ?? null,
      top7d: parsed?.top7d ?? null,
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return EMPTY(); // never written yet
    console.error("⚠️  Failed to read ETN bridge data from R2:", err.message);
    return EMPTY();
  }
}

/** Publishes the whole object plus `updatedAt`. Short cache lifetime — a live time series. */
export async function setEtnBridgeData(data) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ ...data, updatedAt: new Date().toISOString() }),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
