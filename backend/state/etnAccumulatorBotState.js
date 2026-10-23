import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// The ETN accumulator bot's own books (utils/etnAccumulatorBot.js): budget, open/closed lots, the
// price EMA. Same bucket/credentials as every other state/*.js file. Paper and live runs keep
// separate objects, so switching ETN_BOT_MODE to live starts from a clean ledger.
//
// Unlike most state files here, a READ FAILURE THROWS instead of returning null: these books are
// what stop the bot treating the wallet's other ETN as its own, or forgetting stablecoin it's
// holding for a buyback. "Never written" (404) is the only case that returns null (a genuine first
// run); anything else makes the bot skip the tick.
const keyFor = (mode) => (mode === "live" ? "etn-accumulator-bot-live.json" : "etn-accumulator-bot-paper.json");

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

export function botStateConfigured() {
  return Boolean(getR2Client());
}

/** The saved books for `mode`, or null if never written. Throws on any other failure. */
export async function getBotState(mode) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: keyFor(mode) }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    throw err;
  }
}

export async function setBotState(mode, state) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: keyFor(mode),
      Body: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );
}
