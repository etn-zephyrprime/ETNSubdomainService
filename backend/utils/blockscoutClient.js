// backend/utils/blockscoutClient.js
//
// Small retrying JSON fetch against Blockscout's v2 API — shared by walletAlertScheduler.js and
// portfolioValuation.js (Core tier's polling-based alert features), both of which need a direct,
// on-demand read of one specific endpoint, not the paginated walk-everything helpers
// pnlIngestion.js's own fetchPage/walkAllPages are built for.
import { EXPLORER_BASE_URL } from "../services/pnlIngestion.js";

const BLOCKSCOUT_API_BASE = `${EXPLORER_BASE_URL}/api/v2`;
const FETCH_TIMEOUT_MS = 20000;

export async function fetchBlockscoutJson(path, attempt = 0) {
  try {
    const res = await fetch(`${BLOCKSCOUT_API_BASE}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } catch (err) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return fetchBlockscoutJson(path, attempt + 1);
    }
    throw err;
  }
}
