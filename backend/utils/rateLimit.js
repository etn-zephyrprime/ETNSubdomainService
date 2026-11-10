// A small in-memory fixed-window rate limiter, keyed per route + caller (IP or wallet). Per process —
// enough for one Render instance; a restart resets the windows.

/** Returns `hit(key) -> { ok, retryAfterSec }`: at most `max` hits per `windowMs` per key. */
export function createRateLimiter({ max, windowMs, maxKeys = 10000 }) {
  const windows = new Map(); // key -> { start, count }
  return function hit(key) {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= windowMs) {
      if (windows.size >= maxKeys) windows.delete(windows.keys().next().value);
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    return w.count <= max ? { ok: true, retryAfterSec: 0 } : { ok: false, retryAfterSec: Math.ceil((w.start + windowMs - now) / 1000) };
  };
}

/** The caller's IP (Render sits behind a proxy, so the first X-Forwarded-For hop). */
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (typeof xff === "string" && xff.split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
