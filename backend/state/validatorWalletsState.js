import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache validatorWalletsCache.js maintains — every Electroneum validator's ETN balance,
// its daily balance over the last 90 days, and every outgoing transaction (any size) — for the
// Validators view of Argus's Team Wallets tab. Same bucket/credentials/shape convention as
// teamWalletsState.js.
const CACHE_KEY = "validator-wallets.json";

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

/** The last published object, or null if never written / R2 isn't configured / the read failed. */
export async function getValidatorWalletsCache() {
  const r2 = getR2Client();
  if (!r2) return null;
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    console.error("⚠️  Failed to read validator wallets cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ validators, outgoing, series, ... , updatedAt }`. */
export async function setValidatorWalletsCache(data) {
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
