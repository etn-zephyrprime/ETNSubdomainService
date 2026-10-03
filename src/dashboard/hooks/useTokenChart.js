import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Backs TokenDetail.jsx's price chart — calls this app's own backend (tokenChartRouter.js), not
// GeckoTerminal directly. GeckoTerminal's free onchain API is the one dashboard data source that
// isn't safe to call straight from the browser (confirmed live: 429s after a handful of requests
// in quick succession, no way for one visitor's browser to coordinate with any other's), so this
// is the one dashboard feature routed through a backend proxy — see that file's header comment.
export function useTokenChart() {
  // `currency`: "usd" (default) or "wetn" — "wetn" denominates the chart directly in the pool's
  // own WETN-reserve ratio (the same figure GeckoTerminal's own site shows, e.g. "1 CORE =
  // 13.74 WETN") instead of dividing two independently-sourced USD prices — see
  // tokenChartRouter.js's own loadTokenChart comment for why that division drifted from the real
  // on-chain ratio by a few percent. `hasWetnPool` is always present (even for "usd" requests) so
  // a caller can decide whether to offer the ETN toggle at all without a second round trip.
  const getTokenChart = useCallback(async (address, range, currency = "usd") => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-chart?address=${address}&range=${range}&currency=${currency}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const err = new Error(data?.error || `Token chart request failed (${res.status})`);
      // Preserved so a caller can tell "GeckoTerminal is rate-limited right now, worth a retry"
      // (503 — see tokenChartRouter.js's own err.rateLimited handling) apart from every other
      // failure (400 bad request, 502 generic upstream failure) — the plain Error this used to
      // throw lost the status entirely, so nothing downstream could make that distinction.
      err.status = res.status;
      throw err;
    }
    return res.json(); // { hasData, candles?, pool?, hasWetnPool }
  }, []);

  return { getTokenChart };
}
