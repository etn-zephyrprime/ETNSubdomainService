// backend/scripts/appCheckStatus.js — what App Check's scans and cache hold (read-only).
//
// Usage (from backend/):  node scripts/appCheckStatus.js            the latest scan of every site + its cached result
//                         node scripts/appCheckStatus.js <origin>   every scan of one site, and its change events
import dotenv from "dotenv";
import { query } from "../db/pool.js";

dotenv.config();
const origin = process.argv[2]?.toLowerCase().replace(/\/+$/, "") || null;
const t = (d) => new Date(d).toISOString().replace("T", " ").slice(0, 16);

const scans = await query(
  origin
    ? `SELECT * FROM app_scans WHERE origin = $1 ORDER BY id`
    : `SELECT DISTINCT ON (origin) * FROM app_scans ORDER BY origin, id DESC`,
  origin ? [origin] : []
);
const cache = await query(`SELECT origin, result, checked_at, expires_at FROM app_check_cache ${origin ? "WHERE origin = $1" : ""}`, origin ? [origin] : []);
const cached = new Map((cache?.rows || []).map((r) => [r.origin, r]));

for (const s of scans?.rows || []) {
  const r = cached.get(s.origin)?.result;
  const sc = r?.scan || {};
  console.log(
    `${t(s.scanned_at)}  ${s.status.padEnd(7)}  ${String(Object.keys(s.addresses || {}).length).padStart(3)} addresses  ${String((s.contracts || []).length).padStart(3)} contracts  ${String(Object.keys(s.script_hashes || {}).length).padStart(3)} scripts  ${s.origin}`
  );
  const why = [];
  if (s.error) why.push(`failed fetches: ${s.error}`);
  if (sc.truncated && Object.keys(sc.truncated).length) why.push(`caps: ${JSON.stringify(sc.truncated)}`);
  if (sc.requests != null) why.push(`${sc.requests} requests, ${Math.round((sc.bytes || 0) / 1024)} KB, ${sc.chunkMisses ?? 0} chunk misses`);
  if (sc.unchecked?.length) why.push(`${sc.unchecked.length} addresses not checked (RPC)`);
  if (why.length) console.log(`      ${why.join(" · ")}`);
  if (r) console.log(`      badge ${r.overall} — ${r.overallReason}`);
}
if (origin) {
  const ev = await query(`SELECT id, type, severity, details, detected_at FROM app_change_events WHERE origin = $1 ORDER BY id`, [origin]);
  console.log(`\n${ev?.rows?.length || 0} change event(s)`);
  for (const e of ev?.rows || []) console.log(`  #${e.id} ${t(e.detected_at)} ${e.severity.padEnd(7)} ${e.type} ${JSON.stringify(e.details)}`);
}
process.exit(0);
