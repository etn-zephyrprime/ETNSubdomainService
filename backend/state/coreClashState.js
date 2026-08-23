// backend/state/coreClashState.js
//
// Same R2-backed-with-local-fallback pattern as state.js, generalized to multiple named keys —
// the Core Clash watchers (coreClash*.js) each need their own independent cursor (burn/swap/NFT
// mint/NFT sale each watch a different contract) plus the advert scheduler's own queue state,
// rather than the single lastProcessedBlock state.js tracks for the marketplace watcher.
//
// Reuses the exact same R2 bucket/credentials already configured for NFT images
// (R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) — just under different
// object keys (see KEY_PREFIX) so they can't collide with an image key or state.js's own
// "watcher-state.json".
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.join(__dirname, "..", "data");
const KEY_PREFIX = "coreclash-bot-state/";

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

function localPathFor(key) {
  return path.join(LOCAL_DIR, `coreclash-${key}.json`);
}

function readLocal(key) {
  try {
    const file = localPathFor(key);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`⚠️  [coreClashState] Failed to read local state for "${key}":`, err.message);
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(localPathFor(key), JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`⚠️  [coreClashState] Failed to write local state for "${key}":`, err.message);
  }
}

/** Reads a JSON value previously stored under `key`, or null if never written. */
export async function getState(key) {
  const r2 = getR2Client();
  if (!r2) return readLocal(key);

  try {
    const res = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `${KEY_PREFIX}${key}.json` })
    );
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet — a genuine first run, not a failure
    }
    console.error(`⚠️  [coreClashState] Failed to read "${key}" from R2, falling back to local file:`, err.message);
    return readLocal(key);
  }
}

/** Persists a JSON-serializable value under `key`. */
export async function setState(key, value) {
  const r2 = getR2Client();
  if (!r2) {
    writeLocal(key, value);
    return;
  }

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `${KEY_PREFIX}${key}.json`,
        Body: JSON.stringify(value, null, 2),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error(`⚠️  [coreClashState] Failed to write "${key}" to R2, falling back to local file:`, err.message);
    writeLocal(key, value);
  }
}
