import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Backs TokenDetail.jsx's price chart — calls this app's own backend (tokenChartRouter.js), not
// GeckoTerminal directly. GeckoTerminal's free onchain API is the one dashboard data source that
// isn't safe to call straight from the browser (confirmed live: 429s after a handful of requests
// in quick succession, no way for one visitor's browser to coordinate with any other's), so this
// is the one dashboard feature routed through a backend proxy — see that file's header comment.
export function useTokenChart() {
  const getTokenChart = useCallback(async (address, range) => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-chart?address=${address}&range=${range}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Token chart request failed (${res.status})`);
    }
    return res.json(); // { hasData, candles?, pool? }
  }, []);

  return { getTokenChart };
}
