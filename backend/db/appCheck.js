import { query } from "./pool.js";

// App Check phase 3 storage (migrations/033_app_check_cache.sql): result cache, scans, change events, follows.

const iso = (t) => (t ? new Date(t).toISOString() : null);

// ── cache ──────────────────────────────────────────────────────────────────────────────────────────────
/** `{ origin, result, fingerprint, meta, checkedAt, expiresAt }` or null. */
export async function getAppCache(origin) {
  const res = await query(`SELECT origin, result, fingerprint, meta, checked_at, expires_at FROM app_check_cache WHERE origin = $1`, [origin]);
  const r = res?.rows?.[0];
  return r ? { origin: r.origin, result: r.result, fingerprint: r.fingerprint, meta: r.meta || {}, checkedAt: iso(r.checked_at), expiresAt: iso(r.expires_at) } : null;
}

export async function putAppCache({ origin, result, fingerprint, meta, checkedAt, expiresAt }) {
  await query(
    `INSERT INTO app_check_cache (origin, result, fingerprint, meta, checked_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (origin) DO UPDATE SET result = EXCLUDED.result, fingerprint = EXCLUDED.fingerprint, meta = EXCLUDED.meta,
       checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at`,
    [origin, JSON.stringify(result), fingerprint, JSON.stringify(meta || {}), checkedAt, expiresAt]
  );
}

// ── scans ──────────────────────────────────────────────────────────────────────────────────────────────
const scanRow = (r) => ({
  id: Number(r.id),
  origin: r.origin,
  appId: r.app_id == null ? null : Number(r.app_id),
  scannedAt: iso(r.scanned_at),
  status: r.status,
  htmlHash: r.html_hash,
  etag: r.etag,
  lastModified: r.last_modified,
  scriptUrls: r.script_urls || [],
  scriptHashes: r.script_hashes || {},
  addresses: r.addresses || {},
  contracts: r.contracts || [],
  error: r.error,
});

/** Stores one scan; returns its id. `contracts` = the addresses with code (the authoritative set when ok). */
export async function insertAppScan({ origin, appId = null, scan }) {
  const res = await query(
    `INSERT INTO app_scans (origin, app_id, scanned_at, status, html_hash, etag, last_modified, script_urls, script_hashes, addresses, contracts, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      origin,
      appId,
      scan.scannedAt,
      scan.status,
      scan.htmlHash,
      scan.etag,
      scan.lastModified,
      JSON.stringify(scan.scriptUrls || []),
      JSON.stringify(scan.scriptHashes || {}),
      JSON.stringify(scan.addresses || {}),
      JSON.stringify((scan.contracts || []).map((c) => c.address)),
      scan.errors?.length ? scan.errors.map((e) => e.code).join(",").slice(0, 500) : null,
    ]
  );
  return Number(res.rows[0].id);
}

/** The latest scans of an origin, newest first; `status` filters (e.g. "ok" for baselines). */
export async function latestAppScans(origin, { status = null, limit = 2 } = {}) {
  const res = status
    ? await query(`SELECT * FROM app_scans WHERE origin = $1 AND status = $2 ORDER BY scanned_at DESC, id DESC LIMIT $3`, [origin, status, limit])
    : await query(`SELECT * FROM app_scans WHERE origin = $1 ORDER BY scanned_at DESC, id DESC LIMIT $2`, [origin, limit]);
  return (res?.rows || []).map(scanRow);
}

// ── change events ──────────────────────────────────────────────────────────────────────────────────────
const eventRow = (r) => ({ id: Number(r.id), origin: r.origin, appId: r.app_id == null ? null : Number(r.app_id), type: r.type, severity: r.severity, details: r.details || {}, detectedAt: iso(r.detected_at) });

export async function insertAppChangeEvents(events) {
  const ids = [];
  for (const e of events) {
    const res = await query(`INSERT INTO app_change_events (origin, app_id, type, severity, details) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [e.origin, e.appId ?? null, e.type, e.severity, JSON.stringify(e.details || {})]);
    ids.push(Number(res.rows[0].id));
  }
  return ids;
}

/** Recent events for a card: by origin, or by app when it's a registry app. */
export async function recentAppChangeEvents({ origin, appId = null, limit = 10 }) {
  const res = await query(`SELECT * FROM app_change_events WHERE origin = $1 OR ($2::bigint IS NOT NULL AND app_id = $2) ORDER BY id DESC LIMIT $3`, [origin, appId, limit]);
  return (res?.rows || []).map(eventRow);
}

export async function appChangeEventsSince(afterId, limit = 200) {
  const res = await query(`SELECT * FROM app_change_events WHERE id > $1 ORDER BY id LIMIT $2`, [afterId, limit]);
  return (res?.rows || []).map(eventRow);
}

export async function latestAppChangeEventId() {
  const res = await query(`SELECT COALESCE(MAX(id), 0) AS id FROM app_change_events`);
  return Number(res?.rows?.[0]?.id || 0);
}

// ── registry contracts found by scans ──────────────────────────────────────────────────────────────────
/** Records a registry app's scanned contracts (source 'scan'); registry-sourced rows are left alone. */
export async function upsertScanContracts(appId, addresses) {
  for (const a of addresses) {
    await query(
      `INSERT INTO known_app_contracts (app_id, address, source, status) VALUES ($1, $2, 'scan', 'active')
       ON CONFLICT (app_id, address, source) DO UPDATE SET status = 'active', last_seen = now()`,
      [appId, a]
    );
  }
}

export async function markScanContractRemoved(appId, address) {
  await query(`UPDATE known_app_contracts SET status = 'removed' WHERE app_id = $1 AND address = $2 AND source = 'scan'`, [appId, address]);
}

// ── follows ────────────────────────────────────────────────────────────────────────────────────────────
export async function addAppFollow(wallet, origin, appId = null) {
  await query(`INSERT INTO app_follows (wallet, origin, app_id) VALUES ($1, $2, $3) ON CONFLICT (wallet, origin) DO UPDATE SET app_id = EXCLUDED.app_id`, [wallet.toLowerCase(), origin, appId]);
}

export async function removeAppFollow(wallet, origin) {
  const res = await query(`DELETE FROM app_follows WHERE wallet = $1 AND origin = $2 RETURNING origin`, [wallet.toLowerCase(), origin]);
  return Boolean(res?.rows?.length);
}

/** A member's follows: [{ origin, appId, createdAt }]. */
export async function listAppFollows(wallet) {
  const res = await query(`SELECT origin, app_id, created_at FROM app_follows WHERE wallet = $1 ORDER BY created_at`, [wallet.toLowerCase()]);
  return (res?.rows || []).map((r) => ({ origin: r.origin, appId: r.app_id == null ? null : Number(r.app_id), createdAt: iso(r.created_at) }));
}

/** Every follow: [{ wallet, origin, appId }] (the rescan job and the alerts). */
export async function allAppFollows() {
  const res = await query(`SELECT wallet, origin, app_id FROM app_follows`);
  return (res?.rows || []).map((r) => ({ wallet: r.wallet, origin: r.origin, appId: r.app_id == null ? null : Number(r.app_id) }));
}
