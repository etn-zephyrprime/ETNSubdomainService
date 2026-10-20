// backend/utils/memoryMonitor.js
//
// The web service has repeatedly died with a V8 heap OOM (exit 134) after ~7-8h of uptime, near
// the ~256 MB heap limit of the 512 MB instance — and each restart wipes the shell jobs and the
// evidence with it. This logs heap usage plus the size of every registered in-memory cache (see
// boundedMap.js's registerCache) on an interval, so Render's logs show what was growing in the
// hours before a crash. Above HIGH_WATER of the heap limit it logs every minute instead.
import v8 from "v8";
import { cacheSizes } from "./boundedMap.js";

const INTERVAL_MS = process.env.MEMORY_LOG_INTERVAL_MS ? parseInt(process.env.MEMORY_LOG_INTERVAL_MS, 10) : 10 * 60 * 1000;
const HIGH_WATER_INTERVAL_MS = 60 * 1000;
const HIGH_WATER = 0.8;

const mb = (bytes) => Math.round(bytes / 1048576);

function logMemory() {
  const m = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit;
  const ratio = m.heapUsed / limit;
  const caches = Object.entries(cacheSizes())
    .map(([name, size]) => `${name}=${size}`)
    .join(" ");
  const prefix = ratio >= HIGH_WATER ? "⚠️  [mem] HIGH" : "[mem]";
  console.log(
    `${prefix} uptime=${Math.round(process.uptime() / 60)}m rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(limit)}MB (${Math.round(ratio * 100)}%) ` +
      `external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB | ${caches}`
  );
  if (ratio >= HIGH_WATER) {
    const spaces = v8
      .getHeapSpaceStatistics()
      .map((s) => `${s.space_name}=${mb(s.space_used_size)}MB`)
      .join(" ");
    console.log(`⚠️  [mem] heap spaces: ${spaces}`);
  }
  return ratio;
}

export function startMemoryMonitor() {
  let lastLoggedAt = 0;
  logMemory();
  lastLoggedAt = Date.now();
  // Checks every minute but only logs on INTERVAL_MS, unless the heap is above HIGH_WATER.
  setInterval(() => {
    const now = Date.now();
    const m = process.memoryUsage();
    const high = m.heapUsed / v8.getHeapStatistics().heap_size_limit >= HIGH_WATER;
    if (high || now - lastLoggedAt >= INTERVAL_MS) {
      logMemory();
      lastLoggedAt = now;
    }
  }, HIGH_WATER_INTERVAL_MS).unref();
}
