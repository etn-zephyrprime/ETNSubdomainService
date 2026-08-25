import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache ownedNamesCache.js maintains — same role as activatedDomainsState.js's
// CACHE_KEY, but scoped to every *wrapped* name (top-level or subname) regardless of activation
// status, since "Manage & Resell" / "Register Subdomain" need to list a wallet's own names even
// before they've activated subname-selling on them. Same bucket/credentials as this repo's other
// state modules; this key can't collide with any of theirs.
const CACHE_KEY = "owned-names.json";

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
export async function getOwnedNamesCache() {
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
    console.error("⚠️  Failed to read owned names cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ names: [...], lastScannedBlock, schemaVersion, updatedAt }`. */
export async function setOwnedNamesCache(names, lastScannedBlock, schemaVersion) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ names, lastScannedBlock, schemaVersion, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
