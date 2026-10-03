// backend/utils/blockscoutClient.js
//
// Small retrying JSON fetch against Blockscout's v2 API — shared by walletAlertScheduler.js and
// portfolioValuation.js (Core tier's polling-based alert features), both of which need a direct,
// on-demand read of one specific endpoint, not the paginated walk-everything helpers
// pnlIngestion.js's own fetchPage/walkAllPages are built for.
// Computed directly rather than importing pnlIngestion.js's own EXPLORER_BASE_URL export —
// pnlIngestion.js's import chain (pnlPricing.js -> tokenChartRouter.js -> tokenBurnService.js)
// reaches back into this exact file for fetchBlockscoutJson, so importing a binding FROM
// pnlIngestion.js here closes a circular dependency. Confirmed live: any entry point that imports
// pnlIngestion.js directly before anything else (e.g. backfillDeferredPrices.js's script) hits
// Node mid-way through evaluating pnlIngestion.js's own module body — before its
// EXPLORER_BASE_URL export initializes — so this file's top-level read of it lands in the binding's
// temporal dead zone ("Cannot access 'EXPLORER_BASE_URL' before initialization"), crashing the
// whole process before main() ever runs. Same fallback value pnlIngestion.js computes for itself,
// just independently, so neither file needs to import the other's copy of it.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";

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
