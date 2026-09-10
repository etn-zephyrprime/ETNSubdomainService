import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Backs coreTierDemoRouter.js's GET /premium/demo/pnl -- the Core Tier demo used to compute its 3
// wallets' PnL/DeFi/LP/NFT data live on every cache miss (see that file's own getDemoData(), still
// kept as a fallback below), which was slow and expensive enough on its own before a since-fixed bug
// doubled the cost further (see ingestWalletHistory's inFlightIngestions comment) -- expensive enough
// that a cold cache regularly timed out the whole request. The demo's data doesn't need to be live
// (it's an anonymized preview, not a real member's actual account), so it's now computed ONCE by
// backend/scripts/generateDemoSnapshot.js and served from here instead -- same shape as
// notisLinkState.js's own R2 JSON blob, just a single, already-anonymized snapshot rather than a
// live map.
const STATE_KEY = "core-tier-demo-snapshot.json";

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

/** Reads the stored { data, generatedAt } snapshot, or null if never generated (or R2 isn't
 * configured) -- the router falls back to a live computation in that case. */
export async function getDemoSnapshot() {
  const r2 = getR2Client();
  if (!r2) return null;

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return parsed?.data ? parsed : null;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never generated yet
    }
    console.error("⚠️  Failed to read Core Tier demo snapshot from R2:", err.message);
    return null;
  }
}

/** Persists the anonymized demo payload, stamped with when it was generated. */
export async function setDemoSnapshot(data) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 isn't configured (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) -- can't persist the demo snapshot.");

  const payload = { data, generatedAt: new Date().toISOString() };
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: STATE_KEY,
      Body: JSON.stringify(payload, null, 2),
      ContentType: "application/json",
    })
  );
}
