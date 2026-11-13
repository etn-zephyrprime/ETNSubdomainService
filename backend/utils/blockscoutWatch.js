// Blockscout watch — catches Electroneum explorer upgrades before they quietly corrupt data.
//
// Why: Blockscout v12.0.4 (Electroneum upgraded ~2026-11-11/12) renamed token-object fields
// (address -> address_hash, holders -> holders_count). That rename is NOT on Blockscout's own v12
// breaking-changes list, so release notes alone can't be trusted. It emptied the dashboard Tokens tab
// and made PnL ingestion store token transfers with no token address, advancing its cursor past them.
//
// Three parts, all run every CHECK_INTERVAL_MS by one in-process scheduler:
//   1. Version watch: /config/backend-version. A change → admin Telegram alert (old → new + release link).
//   2. Field checks: a handful of live sample responses, run through the SAME normalizer every fetcher
//      uses (blockscoutNormalize.js), must still carry every field our code reads. Catches renames even
//      with no version bump.
//   3. Ingestion pause: while any field check fails, doIngestWalletHistory refuses to start (the job is
//      marked FAILED with the reason, and the normal failure cooldown retries it later). It clears itself
//      the moment checks pass again, e.g. after a normalizer fix deploys. BLOCKSCOUT_WATCH_PAUSE=off
//      disables the pause (alerts still fire).
//
// State lives in contract_alert_state (key/value, compare-and-set), so overlapping servers during a
// deploy agree on one state and only the server whose write wins sends each alert.
import { fetchBlockscoutJsonOrNull } from "./blockscoutClient.js";
import { getAlertState, advanceAlertState } from "../db/contractAlerts.js";
import { sendTelegramDirectMessage } from "./telegramNotifier.js";

export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const VERSION_KEY = "blockscout:version";
const SCHEMA_KEY = "blockscout:schema";

// Stable, always-busy sample addresses: WETN and the main WETN/BOLT V3 pool.
const WETN = "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77";
const SAMPLE_WALLET = "0x2Df6c494B5e96b781b5cB410C4889D4f079bad30";

const first = (json) => (Array.isArray(json) ? json[0] : json?.items?.[0]);

/**
 * Each check: a live path, which object to inspect, and the dotted fields our code reads from it
 * (after normalization). An empty sample (no items) is "skipped", never a failure.
 */
export const SCHEMA_CHECKS = [
  { name: "token list", path: "/tokens?type=ERC-20", pick: first, fields: ["address", "holders", "symbol", "decimals", "type", "name"] },
  { name: "token detail", path: `/tokens/${WETN}`, pick: (j) => j, fields: ["address", "holders", "symbol", "decimals", "type", "total_supply"] },
  { name: "token balances", path: `/addresses/${SAMPLE_WALLET}/token-balances`, pick: first, fields: ["token.address", "token.decimals", "token.type", "value"] },
  {
    name: "token transfers",
    path: `/addresses/${SAMPLE_WALLET}/token-transfers`,
    pick: first,
    fields: ["block_number", "transaction_hash", "timestamp", "log_index", "from.hash", "to.hash", "token.address", "token.type", "token.decimals", "total.value"],
  },
  {
    name: "transactions",
    path: `/addresses/${SAMPLE_WALLET}/transactions`,
    pick: first,
    fields: ["hash", "block_number", "timestamp", "from.hash", "to", "value", "status", "result", "fee.value", "gas_used", "gas_price"],
  },
  {
    name: "internal transactions",
    path: `/addresses/${SAMPLE_WALLET}/internal-transactions`,
    pick: first,
    fields: ["transaction_hash", "block_number", "timestamp", "from.hash", "to", "value", "success", "type"],
  },
];

function hasPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

/** Fields in `fields` missing from `obj`, plus same-level keys that look like their replacement. */
export function missingFields(obj, fields) {
  const missing = [];
  for (const f of fields) {
    if (hasPath(obj, f)) continue;
    const parts = f.split(".");
    const leaf = parts.pop();
    const parent = parts.length ? parts.reduce((o, p) => (o && typeof o === "object" ? o[p] : undefined), obj) : obj;
    const keys = parent && typeof parent === "object" ? Object.keys(parent) : [];
    const candidates = keys.filter((k) => k !== leaf && (k.startsWith(`${leaf}_`) || k.endsWith(`_${leaf}`)));
    missing.push(candidates.length ? `${f} (now ${candidates.map((c) => [...parts, c].join(".")).join(" / ")}?)` : f);
  }
  return missing;
}

/** Runs every SCHEMA_CHECK. Returns { ok, failures: [{ name, missing|error }], skipped: [names] }. */
export async function runSchemaChecks({ fetchJson = fetchBlockscoutJsonOrNull, checks = SCHEMA_CHECKS } = {}) {
  const failures = [];
  const skipped = [];
  for (const check of checks) {
    let json;
    try {
      json = await fetchJson(check.path);
    } catch (err) {
      // Explorer down or slow is an outage, not a schema change — don't pause ingestion over it.
      skipped.push(`${check.name} (unreachable: ${err.message})`);
      continue;
    }
    const obj = json == null ? null : check.pick(json);
    if (obj == null) {
      skipped.push(`${check.name} (no sample)`);
      continue;
    }
    const missing = missingFields(obj, check.fields);
    if (missing.length) failures.push({ name: check.name, missing });
  }
  return { ok: failures.length === 0, failures, skipped };
}

export async function fetchBackendVersion(fetchJson = fetchBlockscoutJsonOrNull) {
  const json = await fetchJson("/config/backend-version").catch(() => null);
  return typeof json?.backend_version === "string" ? json.backend_version : null;
}

const releaseUrl = (v) => `https://github.com/blockscout/blockscout/releases/tag/${v}`;

export function formatVersionAlert(prev, next) {
  return `🔎 *Electroneum Blockscout upgraded*\n${prev} → *${next}*\n\nRelease notes: ${releaseUrl(next)}\nField checks run on the same cycle; you'll get a separate alert if anything we read changed.`;
}

export function formatSchemaAlert(result, paused) {
  const lines = result.failures.map((f) => `• *${f.name}*: missing ${f.missing.join(", ")}`);
  return [
    "⚠️ *Blockscout API fields changed*",
    ...lines,
    "",
    paused
      ? "PnL ingestion is *paused* until this clears (it resumes by itself once the checks pass, e.g. after a fix in blockscoutNormalize.js deploys)."
      : "Ingestion pause is disabled (BLOCKSCOUT_WATCH_PAUSE=off), so ingestion is still running.",
  ].join("\n");
}

export const formatSchemaRecoveredAlert = () => "✅ *Blockscout field checks passing again*: PnL ingestion has resumed.";

const pauseEnabled = () => String(process.env.BLOCKSCOUT_WATCH_PAUSE || "on").toLowerCase() !== "off";

/**
 * The ingestion gate. Returns a reason string while ingestion should stay paused, else null. Reads the
 * shared state so every server agrees; a database hiccup returns null (ingestion would fail on its own
 * database writes anyway, and a stuck pause is worse than a missed one).
 */
export async function getIngestionPauseReason({ getState = getAlertState } = {}) {
  if (!pauseEnabled()) return null;
  const state = await getState(SCHEMA_KEY).catch(() => null);
  if (!state || state.ok !== false) return null;
  const what = (state.failures || []).map((f) => `${f.name}: ${f.missing.join(", ")}`).join("; ");
  return `Paused: Blockscout API fields changed (${what}). Resumes automatically once fixed.`;
}

async function notify(text, send) {
  const chatId = process.env.BLOCKSCOUT_WATCH_CHAT_ID;
  if (!chatId) {
    console.warn(`ℹ️  BLOCKSCOUT_WATCH_CHAT_ID not set, alert only logged:\n${text}`);
    return;
  }
  await send(chatId, text);
}

/** One full cycle: version watch, field checks, state + alerts. Exported for tests and the CLI script. */
export async function runBlockscoutWatch({
  fetchJson = fetchBlockscoutJsonOrNull,
  state = { get: getAlertState, advance: advanceAlertState },
  send = sendTelegramDirectMessage,
  checks = SCHEMA_CHECKS,
} = {}) {
  const summary = { version: null, versionChanged: false, schema: null, alerts: [] };

  // 1. Version
  const version = await fetchBackendVersion(fetchJson);
  summary.version = version;
  if (version) {
    const prev = await state.get(VERSION_KEY);
    if (prev !== version && (await state.advance(VERSION_KEY, prev ?? null, version))) {
      summary.versionChanged = prev != null;
      if (prev != null) summary.alerts.push(formatVersionAlert(prev, version)); // first run just records a baseline
    }
  }

  // 2. Field checks
  const result = await runSchemaChecks({ fetchJson, checks });
  summary.schema = result;
  const prevSchema = await state.get(SCHEMA_KEY);
  const next = { ok: result.ok, failures: result.failures, checkedAt: new Date().toISOString(), version };
  const prevKey = prevSchema ? JSON.stringify({ ok: prevSchema.ok, failures: prevSchema.failures }) : null;
  const nextKey = JSON.stringify({ ok: next.ok, failures: next.failures });
  if (prevKey !== nextKey) {
    if (await state.advance(SCHEMA_KEY, prevSchema ?? null, next)) {
      if (!result.ok) summary.alerts.push(formatSchemaAlert(result, pauseEnabled()));
      else if (prevSchema && prevSchema.ok === false) summary.alerts.push(formatSchemaRecoveredAlert());
    }
  }

  for (const text of summary.alerts) await notify(text, send).catch((err) => console.warn("⚠️  Blockscout watch alert failed:", err.message));
  return summary;
}

export function startBlockscoutWatch() {
  const tick = () =>
    runBlockscoutWatch()
      .then((s) => {
        if (!s.schema?.ok) console.warn(`⚠️  Blockscout watch: field checks FAILING (${s.version})`, JSON.stringify(s.schema?.failures));
      })
      .catch((err) => console.warn("⚠️  Blockscout watch cycle failed:", err.message));
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref?.();
  setInterval(tick, CHECK_INTERVAL_MS).unref?.();
  console.log("🔎 Blockscout watch started (version + field checks every 3h)");
}
