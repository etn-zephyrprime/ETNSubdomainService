import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache tokenLocksCache.js maintains — bulk liquidity-lock summaries (count + latest
// unlock date) per token, so the free Tokens tab (TokenLeaderboard.jsx) can show a lock badge for
// every token in the list without each visitor's browser paying ElectroSwap's expensive
// (2000 credit, "heavy") /liquidity-locks call per row. Same shape/purpose as
// tokenLiquidityState.js, just for lock summaries instead of liquidity USD.
const CACHE_KEY = "token-locks.json";

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
 * Reads the last-published locks object, or null if it's never been written yet or R2 isn't
 * configured. No local-file fallback — same reasoning as tokenLiquidityState.js.
 */
export async function getTokenLocksCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read token locks cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ locksByAddress: { [tokenAddress]: { count, latestUnlockAt } }, updatedAt }` —
 * keyed by lowercased token address, same convention as tokenLiquidityState.js's own map. A token
 * absent from `locksByAddress` simply hasn't been checked (or has zero locks) — see
 * tokenLocksCache.js's own comment on why every checked token is included even at count 0. */
export async function setTokenLocksCache(locksByAddress) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ locksByAddress, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
