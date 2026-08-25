import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache activatedDomainsCache.js maintains — same role split as
// subnameDomainsState.js's CACHE_KEY: (1) the frontend fetches this directly over plain HTTPS via
// R2_PUBLIC_URL for the homepage's "Activated Domains" table instead of scanning on-chain history
// itself, and (2) activatedDomainsCache.js reads it back (via credentialed GetObjectCommand, same
// bucket) each tick to resume from lastScannedBlock instead of rescanning from genesis every time.
// Same bucket/credentials as R2Upload.js/state/state.js/subnameDomainsState.js — this key can't
// collide with an NFT image key (always exactly 64 hex chars + ".png") or either of those two
// other state objects' own keys.
const CACHE_KEY = "activated-domains.json";

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
 * run) or R2 isn't configured. No local-file fallback, same reasoning as subnameDomainsState.js —
 * without R2 there's nowhere public for the frontend to fetch this from, so
 * activatedDomainsCache.js simply doesn't run at all in that case.
 */
export async function getActivatedDomainsCache() {
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
    console.error("⚠️  Failed to read activated domains cache from R2:", err.message);
    return null;
  }
}

/**
 * Publishes `{ domains, lastScannedBlock, schemaVersion, updatedAt }`. Short cache lifetime, same
 * as subnameDomainsState.js — ownership/expiry get re-verified every scan cycle (see
 * activatedDomainsCache.js), so a stale CDN copy would show an outdated owner or a "time left"
 * that's already ticked past zero.
 */
export async function setActivatedDomainsCache(domains, lastScannedBlock, schemaVersion) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ domains, lastScannedBlock, schemaVersion, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
