import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache etnPriceCache.js maintains — a single small JSON object the frontend fetches
// directly over plain HTTPS (via R2_PUBLIC_URL) to show a "≈ $X.XX" estimate next to ETN prices
// site-wide, instead of every visitor's browser hitting CoinGecko directly (rate-limit risk for
// a free API key, and a fresh request per page load for a price that only moves every few
// minutes). Same bucket/credentials as every other cache in this backend — this key can't
// collide with an NFT image key (always exactly 64 hex chars + ".png") or any other cache's key.
const CACHE_KEY = "etn-price.json";

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

/**
 * Reads the last-published price object, or null if it's never been written yet or R2 isn't
 * configured. No local-file fallback — without R2 there's nowhere public for the frontend to
 * fetch this from anyway, so etnPriceCache.js simply doesn't run at all in that case.
 */
export async function getEtnPriceCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read ETN price cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ usd, updatedAt }`. Short cache lifetime — this is a live market price. */
export async function setEtnPriceCache(usd) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ usd, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
