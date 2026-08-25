import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache marketplaceSellersCache.js maintains — same role as
// activatedDomainsState.js's CACHE_KEY, scoped down to just "primary name per active listing's
// seller" rather than full listing data. The listings themselves stay a live on-chain read (see
// marketplaceSellersCache.js's header comment for why) — only the seller-name resolution, the
// part that was silently failing, moves server-side. Same bucket/credentials as the other state
// modules in this repo; this key can't collide with any of theirs.
const CACHE_KEY = "marketplace-sellers.json";

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

/** Reads the last-published cache object, or null if never written / R2 isn't configured. */
export async function getMarketplaceSellersCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY })
    );
    const raw = await res.Body.transformToString();
    return JSON.parse(raw);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read marketplace sellers cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ sellers: { [lowercasedAddress]: primaryName|null }, updatedAt }`. */
export async function setMarketplaceSellersCache(sellers) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ sellers, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
