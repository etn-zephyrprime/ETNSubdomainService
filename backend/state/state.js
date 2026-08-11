import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "data", "state.json");
// Same bucket the NFT images live in (see R2Upload.js) — this key can't collide with a real
// image key, which is always exactly 64 hex chars + ".png" (a node), never this.
const STATE_KEY = "watcher-state.json";

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

function ensureDataDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readLocalState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.lastProcessedBlock === "number" ? data.lastProcessedBlock : null;
  } catch (err) {
    console.error("⚠️  Failed to read local state file:", err.message);
    return null;
  }
}

function writeLocalState(blockNumber) {
  try {
    ensureDataDir();
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastProcessedBlock: blockNumber, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("⚠️  Failed to write local state file:", err.message);
  }
}

export async function getLastProcessedBlock() {
  const r2 = getR2Client();
  if (!r2) return readLocalState();

  try {
    const res = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: STATE_KEY })
    );
    const raw = await res.Body.transformToString();
    const data = JSON.parse(raw);
    return typeof data.lastProcessedBlock === "number" ? data.lastProcessedBlock : null;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") {
      return null; // never written yet — a genuine first run, not a failure
    }
    console.error("⚠️  Failed to read watcher state from R2, falling back to local file:", err.message);
    return readLocalState();
  }
}

export async function setLastProcessedBlock(blockNumber) {
  const r2 = getR2Client();
  if (!r2) {
    writeLocalState(blockNumber);
    return;
  }

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: STATE_KEY,
        Body: JSON.stringify({ lastProcessedBlock: blockNumber, updatedAt: new Date().toISOString() }, null, 2),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("⚠️  Failed to write watcher state to R2, falling back to local file:", err.message);
    writeLocalState(blockNumber);
  }
}
