// backend/utils/boundedMap.js
//
// The "recency-ordered Map with a size cap" pattern several in-memory caches here already inline
// (ledgerCache, transfersMemo, nftSnapshotCache, pricePointMemo), as one helper. A cache keyed by
// wallet/token with no cap only ever grows on a long-running instance; this keeps the most recently
// written entries and drops the oldest.

/** map.set(key, value), moving key to the newest position, then evicts oldest entries past `max`. */
export function setBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

/** Deletes every entry whose `expiresAt` (ms) has passed. For TTL caches that only ever overwrote
 * expired entries on the next read of the same key, never removed them. */
export function sweepExpired(map, now = Date.now()) {
  for (const [key, entry] of map) if (entry && entry.expiresAt <= now) map.delete(key);
}

// Named in-memory caches, so memoryMonitor.js can log their sizes next to heap usage — the point
// being that the next heap OOM shows which cache (if any) had grown, instead of guessing.
const registry = new Map(); // name -> Map | Set

export function registerCache(name, map) {
  registry.set(name, map);
  return map;
}

export function cacheSizes() {
  return Object.fromEntries([...registry].map(([name, m]) => [name, m.size]));
}
