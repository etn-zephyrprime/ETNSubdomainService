import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache tokenLiquidityCache.js maintains — same shape/purpose as tokenPriceState.js,
// just for total-liquidity-USD per token instead of price, so the free Tokens tab
// (TokenLeaderboard.jsx) can sort/display by liquidity without every visitor's browser calling
// ElectroSwap directly. Same bucket/credentials as every other cache in this backend.
const CACHE_KEY = "token-liquidity.json";

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
 * Reads the last-published liquidity object, or null if it's never been written yet or R2 isn't
 * configured. No local-file fallback — same reasoning as tokenPriceState.js: without R2 there's
 * nowhere public for the frontend to fetch this from anyway.
 */
export async function getTokenLiquidityCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read token liquidity cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ liquidityUsd: { [tokenAddress]: usd }, updatedAt }` — `liquidityUsd` is keyed by
 * lowercased token address, same convention tokenPriceState.js's own `prices` map uses. */
export async function setTokenLiquidityCache(liquidityUsd) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ liquidityUsd, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
