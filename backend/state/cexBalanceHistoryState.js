import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache cexBalanceHistory.js maintains — a daily combined ETN balance series across
// every known CEX/bridge address (cex_addresses), plus each one's own current balance — powering
// the free dashboard's CEX Balances tab. Same bucket/credentials/shape convention as this backend's
// other caches (e.g. teamWalletsBalanceHistoryState.js, which this is a close sibling of).
const CACHE_KEY = "cex-balance-history.json";

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

/** Reads `{ series: [{date, totalBalance}], addresses: [{address, label, balance}] }`, or empty
 * defaults if never written / R2 isn't configured. */
export async function getCexBalanceHistoryCache() {
  const r2 = getR2Client();
  if (!r2) return { series: [], addresses: [] };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      series: Array.isArray(parsed?.series) ? parsed.series : [],
      addresses: Array.isArray(parsed?.addresses) ? parsed.addresses : [],
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { series: [], addresses: [] }; // never written yet
    }
    console.error("⚠️  Failed to read CEX balance history from R2:", err.message);
    return { series: [], addresses: [] };
  }
}

/** Publishes `{ series, addresses, updatedAt }`. Longer cache lifetime than this backend's live/
 * near-live caches — a daily-granularity history series doesn't change meaningfully within a
 * minute. */
export async function setCexBalanceHistoryCache(series, addresses) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ series, addresses, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  );
}
