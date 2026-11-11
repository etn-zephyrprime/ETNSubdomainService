import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// App Check API (backend/utils/appCheckRouter.js). `check` works without a wallet (the free lookalike
// check); with a Core Tier signature it returns the full result. Scanning and watching are Core only.
async function asJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const base = `${PNL_BACKEND_URL}/api/app-check`;
const signed = (auth) => (auth ? { wallet: auth.address, signature: auth.signature, timestamp: auth.timestamp } : {});
const post = async (path, body) => asJson(await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

export function useAppCheck() {
  /** The App Check result for a URL, domain or app name (`auth` null = the free lookalike check). */
  const check = useCallback((auth, input) => post("", { input, ...signed(auth) }), []);
  /** Core: the result with a site scan (a stored scan is reused unless `rescan`). */
  const scan = useCallback((auth, input, rescan = false) => post("/scan", { input, rescan, ...signed(auth) }), []);
  /** Core: watch (follow = true) or stop watching an app; returns the member's watched apps. */
  const follow = useCallback((auth, input, on) => post("/follow", { input, follow: on, ...signed(auth) }), []);
  const getFollows = useCallback(async (auth) => (await asJson(await fetch(`${base}/follows?${new URLSearchParams({ wallet: auth.address, signature: auth.signature, timestamp: String(auth.timestamp) })}`))).follows || [], []);
  return { check, scan, follow, getFollows };
}
