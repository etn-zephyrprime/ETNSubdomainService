import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache tokenPriceCache.js maintains — same shape/purpose as etnPriceState.js, just
// for the whitelisted ERC20 payment tokens (BOLT/USDC/USDT/CLUB/CORE/DYNO/DCNT/PDY/FUGAZI)
// instead of ETN itself, so the frontend can show a "≈ $X.XX" estimate next to a token-priced
// subname quote the same way it already does for an ETN one — see UsdEstimate.jsx/
// useTokenPrices.js. Same bucket/credentials as every other cache in this backend — this key
// can't collide with an NFT image key (always exactly 64 hex chars + ".png") or any other cache's
// key.
const CACHE_KEY = "token-prices.json";

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
 * fetch this from anyway, so tokenPriceCache.js simply doesn't run at all in that case.
 */
export async function getTokenPriceCache() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet
    }
    console.error("⚠️  Failed to read token price cache from R2:", err.message);
    return null;
  }
}

/** Publishes `{ prices: { [tokenAddress]: usd }, updatedAt }`. Short cache lifetime — same as
 * etnPriceState.js, these are live market prices. `prices` is keyed by lowercased token address —
 * see useTokenPrices.js's own comment on why lookups always normalize to lowercase too. */
export async function setTokenPriceCache(prices) {
  const r2 = getR2Client();
  if (!r2) return;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ prices, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=60",
    })
  );
}
