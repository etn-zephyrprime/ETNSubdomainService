import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Tracks which expiry-warning tier (see expiryAlertScheduler.js's TIER_DAYS) has already been
// DMed for each { node, expiry } pair, so a restart or the next check cycle doesn't re-send the
// same warning repeatedly. Keyed on the expiry timestamp itself (not just the node) so a renewed
// name — or a genuinely expired one re-registered by someone new — gets treated as a fresh
// warning cycle instead of staying silently suppressed by whatever was sent for its previous
// expiry date. Single small JSON blob, same reasoning as telegramLinkState.js: low traffic,
// read-modify-write per check cycle is fine, not meant to be publicly fetchable.
const STATE_KEY = "expiry-alert-state.json";

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

/** Reads `{ sent: { "<node>:<expiry>": tierDays } }`, or an empty one if never written. */
export async function getExpiryAlertState() {
  const r2 = getR2Client();
  if (!r2) return { sent: {} };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return { sent: parsed?.sent || {} };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { sent: {} }; // never written yet
    }
    console.error("⚠️  Failed to read expiry alert state from R2:", err.message);
    return { sent: {} };
  }
}

/** Persists `{ sent }`. */
export async function setExpiryAlertState(state) {
  const r2 = getR2Client();
  if (!r2) return; // no R2 configured — same no-op as this repo's other R2-only features

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: STATE_KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: "application/json",
    })
  );
}
