import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "data", "state.json");
const LEGACY_STATE_FILE = path.join(__dirname, "..", "data", "state-legacy.json");
// Same bucket the NFT images live in (see R2Upload.js) — this key can't collide with a real
// image key, which is always exactly 64 hex chars + ".png" (a node), never this.
const STATE_KEY = "watcher-state.json";
// marketplaceWatcher.js's own cursor for the deprecated V3 marketplace — separate key/file since
// V3 and V4 have different deploy blocks and this tracks them independently (see
// getLastProcessedLegacyBlock/setLastProcessedLegacyBlock below).
const LEGACY_STATE_KEY = "watcher-state-legacy.json";

/**
 * Tracks the last block marketplaceWatcher.js has fully processed, so a restart doesn't have to
 * guess how far back to scan.
 *
 * Backed by R2 (the same bucket/credentials already configured for NFT images) whenever
 * R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are set — this is what makes
 * state survive Render's free tier, whose local filesystem is wiped on every spin-down/spin-up
 * cycle (a plain local file would otherwise reset every single time, defeating the point).
 * Falls back to a local JSON file when R2 isn't configured (e.g. local dev), matching this
 * module's original behavior — durable across restarts on a normal machine, just not across a
 * wiped filesystem.
 *
 * Parametrized by file/R2 key so the same logic backs both the current (V4) cursor and the
 * deprecated V3 marketplace's own separate cursor, without duplicating the R2-vs-local-file
 * fallback dance twice.
 */

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

function ensureDataDir(stateFile) {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readLocalState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return null;
    const raw = fs.readFileSync(stateFile, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.lastProcessedBlock === "number" ? data.lastProcessedBlock : null;
  } catch (err) {
    console.error("⚠️  Failed to read local state file:", err.message);
    return null;
  }
}

function writeLocalState(stateFile, blockNumber) {
  try {
    ensureDataDir(stateFile);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ lastProcessedBlock: blockNumber, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("⚠️  Failed to write local state file:", err.message);
  }
}

async function getLastProcessedBlockFor(stateFile, stateKey) {
  const r2 = getR2Client();
  if (!r2) return readLocalState(stateFile);

  try {
    const res = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: stateKey })
    );
    const raw = await res.Body.transformToString();
    const data = JSON.parse(raw);
    return typeof data.lastProcessedBlock === "number" ? data.lastProcessedBlock : null;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet — a genuine first run, not a failure
    }
    console.error("⚠️  Failed to read watcher state from R2, falling back to local file:", err.message);
    return readLocalState(stateFile);
  }
}

async function setLastProcessedBlockFor(stateFile, stateKey, blockNumber) {
  const r2 = getR2Client();
  if (!r2) {
    writeLocalState(stateFile, blockNumber);
    return;
  }

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: stateKey,
        Body: JSON.stringify({ lastProcessedBlock: blockNumber, updatedAt: new Date().toISOString() }, null, 2),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("⚠️  Failed to write watcher state to R2, falling back to local file:", err.message);
    writeLocalState(stateFile, blockNumber);
  }
}

export async function getLastProcessedBlock() {
  return getLastProcessedBlockFor(STATE_FILE, STATE_KEY);
}

export async function setLastProcessedBlock(blockNumber) {
  return setLastProcessedBlockFor(STATE_FILE, STATE_KEY, blockNumber);
}

/** Same as getLastProcessedBlock, but for the deprecated V3 marketplace's own cursor. */
export async function getLastProcessedLegacyBlock() {
  return getLastProcessedBlockFor(LEGACY_STATE_FILE, LEGACY_STATE_KEY);
}

/** Same as setLastProcessedBlock, but for the deprecated V3 marketplace's own cursor. */
export async function setLastProcessedLegacyBlock(blockNumber) {
  return setLastProcessedBlockFor(LEGACY_STATE_FILE, LEGACY_STATE_KEY, blockNumber);
}
