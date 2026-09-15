import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache teamWalletsCache.js maintains — each known Electroneum team wallet's current
// ETN balance plus a merged, deduped feed of recent ETN movements across all of them, so Argus's
// Team Wallets tab (src/dashboard/components/TeamWalletsTab.jsx) never hits Blockscout directly
// from the browser for 12+ wallets on every page load. Same bucket/credentials/shape convention
// as every other cache in this backend (e.g. dashboardStatsState.js).
const CACHE_KEY = "team-wallets.json";

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

/** Reads `{ wallets: [...], movements: [...] }`, or empty ones if never written / R2 isn't
 * configured. No local-file fallback — without R2 there's nowhere public for the frontend to
 * fetch this from anyway, same as etnPriceState.js/tokenPriceState.js. */
export async function getTeamWalletsCache() {
  const r2 = getR2Client();
  if (!r2) return { wallets: [], movements: [] };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      wallets: Array.isArray(parsed?.wallets) ? parsed.wallets : [],
      movements: Array.isArray(parsed?.movements) ? parsed.movements : [],
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { wallets: [], movements: [] }; // never written yet
    }
    console.error("⚠️  Failed to read team wallets cache from R2:", err.message);
    return { wallets: [], movements: [] };
  }
}

/** Publishes `{ wallets, movements, updatedAt }`. Short cache lifetime — balances/recent
 * movements are live-ish data, same as this backend's other R2 caches. */
export async function setTeamWalletsCache({ wallets, movements }) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ wallets, movements, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
