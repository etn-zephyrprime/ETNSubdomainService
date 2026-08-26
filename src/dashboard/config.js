// Electroneum's own block explorer (blockexplorer.electroneum.com) runs Blockscout — confirmed
// live against the real v2 API (GET /api/v2/stats, /main-page/*, /tokens, /addresses/{hash}, etc.
// all return real data) and it sets `access-control-allow-origin: *`, so this dashboard calls it
// directly from the browser rather than needing a backend proxy — there's nothing here that
// isn't already public, and Blockscout is already built to serve a public frontend at scale.
export const BLOCKSCOUT_API_BASE =
  import.meta.env.VITE_BLOCKSCOUT_API_BASE || "https://blockexplorer.electroneum.com/api/v2";

export const EXPLORER_BASE_URL =
  import.meta.env.VITE_EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
