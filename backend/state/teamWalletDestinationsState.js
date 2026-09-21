import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The public report teamWalletsDestinations.js maintains — where the suspected team wallets' ETN went over the last
// 12 months, for the Team Wallets tab. Same single-blob R2 pattern as every other cache in this backend.
const CACHE_KEY = "team-wallet-destinations.json";

let cachedR2Client = null;
function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return cachedR2Client;
}

/** The last published report, or null if never written / R2 isn't configured. */
export async function getTeamWalletDestinationsCache() {
  const r2 = getR2Client();
  if (!r2) return null;
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: CACHE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    console.error("⚠️  Failed to read team wallet destinations from R2:", err.message);
    return null;
  }
}

export async function setTeamWalletDestinationsCache(report) {
  const r2 = getR2Client();
  if (!r2) return;
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: CACHE_KEY,
      Body: JSON.stringify(report),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  );
}
