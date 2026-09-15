import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tracks the last block marketplaceWatcher.js has fully processed, per marketplace contract
 * generation, so a restart doesn't have to guess how far back to scan.
 *
 * Backed by R2 (the same bucket/credentials already configured for NFT images) whenever
 * R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are set — this is what makes
 * state survive Render's free tier, whose local filesystem is wiped on every spin-down/spin-up
 * cycle (a plain local file would otherwise reset every single time, defeating the point). Falls
 * back to a local JSON file when R2 isn't configured (e.g. local dev), matching this module's
 * original behavior — durable across restarts on a normal machine, just not across a wiped
 * filesystem.
 *
 * IMPORTANT — these keys are deliberately VERSION-STABLE (one per contract generation: V3, V4,
 * V5, ...), never ROLE-based ("current"/"legacy"). A contract's role shifts on every redeploy (V4
 * was "current" until V5 shipped, and is "legacy" from here on), but whichever key already holds
 * that contract's own real accumulated progress must keep meaning exactly that contract forever —
 * reusing a role-based key across a redeploy would silently apply one contract's cursor value to a
 * DIFFERENT contract's scan. Confirmed live 2026-09-15: V5 deployed at block 15874925 while V4's
 * own real cursor (having run continuously since V4 was "current") was already past that block —
 * if V5 had reused V4's old "current" key as-is, the watcher would have read that already-advanced
 * value, believed itself already caught up, and silently skipped scanning V5's own genesis
 * activity entirely. getLastProcessedV5Block below is a brand new key for exactly this reason;
 * getLastProcessedV4Block/getLastProcessedV3Block deliberately keep the SAME file/R2 key names
 * this module has always used for each of them (the v4State/v3State constants below), even though
 * what those constants are named no longer matches which redeploy is "current" — renaming the
 * underlying key would have thrown away real, already-accumulated progress for no reason.
 */

const v4StateFile = path.join(__dirname, "..", "data", "state.json");
const v4StateKey = "watcher-state.json";
const v3StateFile = path.join(__dirname, "..", "data", "state-legacy.json");
const v3StateKey = "watcher-state-legacy.json";
// New in the V5 rewiring — no prior data to preserve, so this one *can* follow the current
// version number.
const v5StateFile = path.join(__dirname, "..", "data", "state-v5.json");
const v5StateKey = "watcher-state-v5.json";

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

/** V5's own cursor (the current contract as of this rewiring) — brand new key, see this module's
 * own header comment for why it can't reuse V4's old "current" key. */
export async function getLastProcessedV5Block() {
  return getLastProcessedBlockFor(v5StateFile, v5StateKey);
}
export async function setLastProcessedV5Block(blockNumber) {
  return setLastProcessedBlockFor(v5StateFile, v5StateKey, blockNumber);
}

/** V4's own cursor — same key this module has always used for V4 (back when V4 was "current"),
 * carrying its real accumulated progress forward unchanged now that V4 is a legacy source. */
export async function getLastProcessedV4Block() {
  return getLastProcessedBlockFor(v4StateFile, v4StateKey);
}
export async function setLastProcessedV4Block(blockNumber) {
  return setLastProcessedBlockFor(v4StateFile, v4StateKey, blockNumber);
}

/** V3's own cursor — same key this module has always used for V3 (its own legacy cursor since V4
 * first shipped), unaffected by this rewiring at all. */
export async function getLastProcessedV3Block() {
  return getLastProcessedBlockFor(v3StateFile, v3StateKey);
}
export async function setLastProcessedV3Block(blockNumber) {
  return setLastProcessedBlockFor(v3StateFile, v3StateKey, blockNumber);
}
