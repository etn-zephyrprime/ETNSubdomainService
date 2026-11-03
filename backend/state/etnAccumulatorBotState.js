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

// ── Single ownership ─────────────────────────────────────────────────────────────────────────────
// During a Render deploy the old and new instances run side by side for a while; two bots trading the
// same wallet and the same books (each saving over the other's) is how a bridged $89 got "reduced"
// out of the books. Whichever instance holds this lease is the only one allowed to tick; it renews it
// every tick and releases it on shutdown, so the new instance takes over as soon as the old one stops
// (or LEASE_MS after it dies without releasing).
const LEASE_KEY = "etn-accumulator-bot-lease.json";
export const LEASE_MS = 150000;

async function readLease(r2) {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: LEASE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey") return null;
    throw err;
  }
}

async function writeLease(r2, lease) {
  await r2.send(
    new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: LEASE_KEY, Body: JSON.stringify(lease), ContentType: "application/json", CacheControl: "no-store" })
  );
}

/** Takes or renews the lease for `owner`. Returns { ok: true } when this instance may tick, or
 * { ok: false, holder } when another instance holds a live one. Throws on R2 failures (skip the tick). */
export async function claimBotLease(owner, now = Date.now()) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  const cur = await readLease(r2);
  if (cur && cur.owner !== owner && !cur.released && now - cur.at < LEASE_MS) return { ok: false, holder: cur.owner };
  await writeLease(r2, { owner, at: now });
  if (cur?.owner === owner) return { ok: true };
  // Taking it over: read back, in case another instance claimed it in the same moment (last write wins).
  await new Promise((r) => setTimeout(r, 1000));
  const check = await readLease(r2);
  return check?.owner === owner ? { ok: true, took: cur?.owner || null } : { ok: false, holder: check?.owner };
}

/** Gives the lease up (shutdown), if this instance still holds it. */
export async function releaseBotLease(owner) {
  const r2 = getR2Client();
  if (!r2) return;
  const cur = await readLease(r2);
  if (cur?.owner === owner) await writeLease(r2, { owner, at: cur.at, released: true });
}

/** Takes the lease regardless of who holds it — for one-off maintenance scripts that must edit the books
 * while the bot stands by. Release it with releaseBotLease(owner) afterwards. */
export async function forceBotLease(owner) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  await writeLease(r2, { owner, at: Date.now() });
}
