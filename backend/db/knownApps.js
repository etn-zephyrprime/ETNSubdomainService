import { query } from "./pool.js";

// The App Check registry (migrations/031_app_check_registry.sql): apps, their websites, their contracts.
// Small (tens of rows), so it's read whole and kept in memory by services/appCheck/registry.js.

/** Every app with its hosts and active contracts: [{ id, slug, name, category, verifiedByUs, notes, hosts, contracts }]. */
export async function listKnownApps() {
  const [apps, hosts, contracts] = [
    await query(`SELECT id, slug, name, category, verified_by_us, notes FROM known_apps ORDER BY id`),
    await query(`SELECT app_id, host, is_registrable_domain, is_primary FROM known_app_hosts`),
    await query(`SELECT app_id, address, role, source FROM known_app_contracts WHERE status = 'active'`),
  ];
  const byId = new Map(
    (apps?.rows || []).map((r) => [
      String(r.id),
      { id: Number(r.id), slug: r.slug, name: r.name, category: r.category, verifiedByUs: r.verified_by_us, notes: r.notes, hosts: [], contracts: [] },
    ])
  );
  for (const h of hosts?.rows || []) byId.get(String(h.app_id))?.hosts.push({ host: h.host, registrableDomain: h.is_registrable_domain, primary: h.is_primary });
  for (const c of contracts?.rows || []) byId.get(String(c.app_id))?.contracts.push({ address: c.address, role: c.role, source: c.source });
  return [...byId.values()];
}

/**
 * Writes one app from the seed file: the app row (by slug), its host list (replaced as a whole) and its
 * registry contracts (upserted; registry rows no longer in the seed are marked removed, never deleted).
 * Scan-sourced rows are left alone.
 */
export async function upsertKnownApp({ slug, name, category, verifiedByUs = false, notes = null, hosts = [], contracts = [] }) {
  const res = await query(
    `INSERT INTO known_apps (slug, name, category, verified_by_us, notes) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
       verified_by_us = EXCLUDED.verified_by_us, notes = EXCLUDED.notes, updated_at = now()
     RETURNING id`,
    [slug, name, category, verifiedByUs, notes]
  );
  const appId = res.rows[0].id;

  const keep = hosts.map((h) => h.host.toLowerCase());
  await query(`DELETE FROM known_app_hosts WHERE app_id = $1 AND NOT (host = ANY($2::text[]))`, [appId, keep]);
  for (const h of hosts) {
    await query(
      `INSERT INTO known_app_hosts (app_id, host, is_registrable_domain, is_primary) VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, host) DO UPDATE SET is_registrable_domain = EXCLUDED.is_registrable_domain, is_primary = EXCLUDED.is_primary`,
      [appId, h.host.toLowerCase(), !!h.registrableDomain, !!h.primary]
    );
  }

  const addresses = contracts.map((c) => c.address.toLowerCase());
  await query(
    `UPDATE known_app_contracts SET status = 'removed' WHERE app_id = $1 AND source = 'registry' AND status = 'active' AND NOT (address = ANY($2::text[]))`,
    [appId, addresses]
  );
  for (const c of contracts) {
    await query(
      `INSERT INTO known_app_contracts (app_id, address, role, source, status) VALUES ($1, $2, $3, 'registry', 'active')
       ON CONFLICT (app_id, address, source) DO UPDATE SET role = EXCLUDED.role, status = 'active', last_seen = now()`,
      [appId, c.address.toLowerCase(), c.role || null]
    );
  }
  return appId;
}
