import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Combined cursor + pending-batch state for subnamePriceChangeWatcher.js's Telegram notification
// (see that file's own header comment for the batching behavior this backs). One blob rather than
// two separate files since both pieces belong to the same single watcher and are always read/
// written together on every poll cycle — same "single small JSON blob... read-modify-write per
// cycle is fine, not meant to be publicly fetchable" reasoning as expiryAlertState.js.
const STATE_KEY = "subname-price-alert-state.json";

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
 * Reads `{ lastProcessedBlock: number|null, pending: { [parentNode]: { label: string, changes:
 * [{ paymentToken, pricePerYear, blockNumber, txHash }], lastChangedAt: number } } }`, or the
 * empty shape if never written / R2 isn't configured. `lastChangedAt` is a plain `Date.now()`
 * epoch-ms timestamp — it's the sliding-debounce clock subnamePriceChangeWatcher.js resets on
 * every new change to that domain.
 */
export async function getSubnamePriceAlertState() {
  const r2 = getR2Client();
  if (!r2) return { lastProcessedBlock: null, pending: {} };

  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY }));
    const parsed = JSON.parse(await res.Body.transformToString());
    return {
      lastProcessedBlock: typeof parsed?.lastProcessedBlock === "number" ? parsed.lastProcessedBlock : null,
      pending: parsed?.pending || {},
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return { lastProcessedBlock: null, pending: {} }; // never written yet
    }
    console.error("⚠️  Failed to read subname price alert state from R2:", err.message);
    return { lastProcessedBlock: null, pending: {} };
  }
}

/** Persists `{ lastProcessedBlock, pending }`. */
export async function setSubnamePriceAlertState(state) {
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
