import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The persisted "last price we successfully saw" per token — backs lastKnownPrices.js. Plain public market
// data (token address -> USD price + when), stored as a single R2 blob like every other cache here, and NOT
// on the R2 proxy's allowlist (nothing in the frontend reads it).
const CACHE_KEY = "last-known-prices.json";

let cachedR2Client = null;
function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return cachedR2Client;
}

/** `{ [lowercased token address]: { usd, at (ms) } }`, or `{}` if never written / R2 isn't configured / unreadable. */
export async function getLastKnownPricesData() {
  const r2 = getR2Client();
  if (!r2) return {};
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return parsed?.prices && typeof parsed.prices === "object" ? parsed.prices : {};
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return {};
    console.error("⚠️  Failed to read last-known prices from R2:", err.message);
    return {};
  }
}

export async function setLastKnownPricesData(prices) {
  const r2 = getR2Client();
  if (!r2) return;
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ prices, updatedAt: new Date().toISOString() }),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );
}
