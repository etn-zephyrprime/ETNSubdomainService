import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public cache coreTaxScheduleCache.js maintains — which of CORE's fixed tax-tier thresholds
// have actually been crossed on-chain, and exactly when (block + date), so the Tokens tab's CORE
// burn chart can plot real historical buy/sell tax rates instead of a guess. Same bucket/
// credentials/shape convention as this backend's other caches (tokenLiquidityState.js, etc.).
const CACHE_KEY = "core-tax-schedule.json";

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

/** Reads `{ steps: [{ supplyPct, totalSupply, buyTaxPct, sellTaxPct, crossedAtBlock, crossedAt }],
 * updatedAt }`, or null if never published yet / R2 isn't configured. `steps` only ever contains
 * thresholds ALREADY confirmed crossed on-chain — see coreTaxScheduleCache.js's own header comment
 * for why this is safe to treat as append-only (a found crossing block never changes). */
export async function getCoreTaxScheduleCache() {
  const r2 = getR2Client();
  if (!r2) return null;
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    console.error("⚠️  Failed to read CORE tax schedule cache from R2:", err.message);
    return null;
  }
}

export async function setCoreTaxScheduleCache(steps) {
  const r2 = getR2Client();
  if (!r2) return;
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify({ steps, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  );
}
