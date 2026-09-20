import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache hyperlaneBridge.js maintains — every USDT/USDC transfer across the Hyperlane warp routes
// (compact events + per-token current supply/enrolled chains), backing the free dashboard's "Hyperlane
// Bridge" tab. Same single-blob R2 pattern as every other cache in this backend.
const CACHE_KEY = "hyperlane-bridge.json";

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

const EMPTY = () => ({ tokens: [], events: [], cursors: {}, current: {} });

/** Reads `{ tokens, events, cursors, current }`, or an empty one if never written / R2 isn't configured. */
export async function getHyperlaneBridgeData() {
  const r2 = getR2Client();
  if (!r2) return EMPTY();

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      tokens: Array.isArray(parsed?.tokens) ? parsed.tokens : [],
      events: Array.isArray(parsed?.events) ? parsed.events : [],
      cursors: parsed?.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
      current: parsed?.current && typeof parsed.current === "object" ? parsed.current : {},
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return EMPTY(); // never written yet
    console.error("⚠️  Failed to read Hyperlane bridge data from R2:", err.message);
    return null; // unreadable (NOT "empty") — the caller must not overwrite a good file with a fresh one
  }
}

/** Publishes the whole object plus `updatedAt`. Short cache lifetime — a live series. */
export async function setHyperlaneBridgeData(data) {
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
