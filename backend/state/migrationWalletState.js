import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache migrationWalletTracker.js maintains — one specific wallet's ETN balance history
// plus its own recent transaction activity, for the ETN Bridge tab's dedicated watch section. Same
// bucket/credentials/shape convention as this backend's other caches (e.g. cexBalanceHistoryState.js,
// its closest sibling).
const CACHE_KEY = "migration-wallet-history.json";

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

/** Reads `{ balance, series: [{date, balance}], migrationEvent, transactions }`, or empty defaults
 * if never written / R2 isn't configured. */
export async function getMigrationWalletCache() {
  const r2 = getR2Client();
  if (!r2) return { balance: null, series: [], migrationEvent: null, transactions: [] };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      balance: parsed?.balance ?? null,
      series: Array.isArray(parsed?.series) ? parsed.series : [],
      migrationEvent: parsed?.migrationEvent ?? null,
      transactions: Array.isArray(parsed?.transactions) ? parsed.transactions : [],
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { balance: null, series: [], migrationEvent: null, transactions: [] }; // never written yet
    }
    console.error("⚠️  Failed to read migration wallet cache from R2:", err.message);
    return { balance: null, series: [], migrationEvent: null, transactions: [] };
  }
}

/** Publishes `{ balance, series, migrationEvent, transactions, updatedAt }`. */
export async function setMigrationWalletCache(payload) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=120",
    })
  );
}
