// App Check change detection — pure functions over stored scans and contract fingerprints.
//
//   contract_added       an address with code newly in an `ok` scan (vs the previous `ok` scan). Severity =
//                        the new contract's own badge (red -> high, amber -> caution, else info).
//   contract_removed     an address in an earlier `ok` scan that is missing from TWO consecutive `ok` scans.
//                        One scan is never enough (a site can load a contract on some pages only).
//   frontend_redeployed  the HTML or script hashes changed but the contract set didn't — info, never alerted.
//   contract_changed     owner / implementation / code hash of a contract in the app's set changed
//                        (fingerprint comparison). Same severity idea as the watchlist: a proxy upgraded by a
//                        plain wallet (EOA) is high; a code-hash change is high; other changes caution.
//   domain_changed       the registry's host list for an app changed.
// Partial and failed scans produce nothing and never become the baseline.

const SEVERITY_OF_BADGE = { red: "high", amber: "caution" };
export const SEVERITY_RANK = { info: 0, caution: 1, high: 2 };

const setOf = (scan) => new Set(scan?.contracts?.map((c) => (typeof c === "string" ? c : c.address)) || []);

/**
 * Events for a new scan against the previous ok scans (newest first).
 * @param current the new scan (scanSite record: contracts with overall, htmlHash, scriptHashes)
 * @param previousOk [S-1, S-2] stored ok scans (contracts = address list)
 */
export function diffScan(current, previousOk, { origin, appId = null } = {}) {
  if (current?.status !== "ok") return [];
  const [prev, prevPrev] = previousOk || [];
  if (!prev) return []; // the first good scan is the baseline
  const now = setOf(current);
  const before = setOf(prev);
  const events = [];
  const ev = (type, severity, details) => events.push({ origin, appId, type, severity, details });

  for (const c of current.contracts || []) {
    if (before.has(c.address)) continue;
    ev("contract_added", SEVERITY_OF_BADGE[c.overall] || "info", { address: c.address, label: c.label || null, overall: c.overall || "unknown", flagCount: c.flagCount ?? null });
  }
  if (prevPrev) {
    for (const address of setOf(prevPrev)) {
      if (!before.has(address) && !now.has(address)) ev("contract_removed", "caution", { address });
    }
  }
  if (!events.length) {
    const scriptsChanged = JSON.stringify(Object.values(current.scriptHashes || {}).sort()) !== JSON.stringify(Object.values(prev.scriptHashes || {}).sort());
    if (current.htmlHash !== prev.htmlHash || scriptsChanged) ev("frontend_redeployed", "info", { contracts: now.size });
  }
  return events;
}

/** The severity of a fingerprint change on a contract (its fresh facts tell us who controls upgrades). */
export function changeSeverity(changes, facts) {
  const fields = new Set(changes.map((c) => c.field));
  if (fields.has("codeHash")) return "high";
  if (fields.has("implementation")) return facts?.proxy?.upgradeController?.type === "eoa" ? "high" : "caution";
  return "caution";
}

/** contract_changed events for an app's contracts, from [{ address, label, changes, facts }]. */
export function contractChangedEvents(changed, { origin, appId = null }) {
  return changed.map((c) => ({ origin, appId, type: "contract_changed", severity: changeSeverity(c.changes, c.facts), details: { address: c.address, label: c.label || null, changes: c.changes, overall: c.facts?.overall || null } }));
}

/** A registry app's host list as a stable string (domain_changed compares these). */
export const hostsKey = (app) =>
  app.hosts
    .map((h) => `${h.host}${h.registrableDomain ? "+" : ""}`)
    .sort()
    .join(",");

/** domain_changed event for an app whose host list differs from what was recorded, or null. */
export function domainChangedEvent(app, recorded, { origin }) {
  const now = hostsKey(app);
  if (recorded == null || recorded === now) return null;
  const before = new Set(recorded.split(",").filter(Boolean));
  const after = new Set(now.split(",").filter(Boolean));
  return {
    origin,
    appId: app.id > 0 ? app.id : null,
    type: "domain_changed",
    severity: "caution",
    details: { added: [...after].filter((h) => !before.has(h)), removed: [...before].filter((h) => !after.has(h)) },
  };
}

/** Whether an event goes out as an alert at all. */
export function isAlertable(e, { types, addedMinSeverity }) {
  if (!types.includes(e.type)) return false;
  if (e.type === "contract_added") return SEVERITY_RANK[e.severity] >= SEVERITY_RANK[addedMinSeverity];
  return true;
}
