import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache subnameDomainsCache.js maintains — a single small JSON object serving two
// roles at once: (1) the frontend fetches it directly over plain HTTPS via R2_PUBLIC_URL instead
// of scanning ~100k+ blocks of on-chain history itself on every page load, and (2)
// subnameDomainsCache.js reads it back (via credentialed GetObjectCommand, same bucket) each tick
// to resume from lastScannedBlock instead of rescanning from genesis every time. Same
// bucket/credentials as R2Upload.js/state/state.js — this key can't collide with an NFT image key
// (always exactly 64 hex chars + ".png") or state.js's own "watcher-state.json".
const CACHE_KEY = "subname-domains.json";

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
 * Reads the last-published cache object, or null if it's never been written yet (a genuine first
 * run) or R2 isn't configured. Unlike state/state.js, this has no local-file fallback — without
 * R2 there's nowhere public for the frontend to fetch this from anyway, so subnameDomainsCache.js
 * simply doesn't run at all in that case (see its own R2-configured check).
 */
export async function getSubnameDomainsCache() {
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
    console.error("⚠️  Failed to read subname domains cache from R2:", err.message);
    return null;
  }
}

/**
 * Publishes `{ domains, lastScannedBlock, updatedAt }`. Short cache lifetime (unlike NFT images'
 * immutable 1-year one in R2Upload.js) — this changes every time an owner sets/changes a subname
 * price, so a stale CDN copy would show wrong prices or miss new domains for however long it's
 * cached.
 */
export async function setSubnameDomainsCache(domains, lastScannedBlock) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ domains, lastScannedBlock, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
