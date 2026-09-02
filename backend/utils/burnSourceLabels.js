// backend/utils/burnSourceLabels.js
//
// Classifies which app mechanism triggered a given CORE burn, for coreClashBurnWatcher.js's
// Telegram alert. CORE has its own fee-on-transfer tax (confirmed live — see
// PlanetZephyros/scripts/autoBuyBackAndBurn.js's own comment on it) that auto-burns a cut on ANY
// transfer, not just an explicit burn() call — so classification looks at the *transaction's own
// destination contract* (tx.to), not the raw Transfer event's donor. Confirmed live this
// distinction matters: the exact same "token swap" burn shows up with the donor as either the
// CORE/WETN pool itself or the swapping wallet's own address depending on which router path was
// used — neither of those donor addresses is itself a meaningful label, but tx.to (the pool, the
// router, or one of this app's own contracts) reliably is.
//
// Static map first (fast, no extra RPC/API call) for every known first-party contract; falls back
// to Blockscout's own verified contract name for anything else, so a genuinely new/unknown
// contract still gets a real label instead of a blanket "Manual burn" the moment it starts
// burning — that fallback is reserved for when even Blockscout has nothing (in practice: a direct
// transfer()/burn() call on the CORE token contract itself from an ordinary wallet, not through
// any known app).
import { CORE_TOKEN_ADDRESS, CORE_WETN_POOL_ADDRESS } from "./coreClashConfig.js";

const MARKETPLACE_ADDRESS = (process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13").toLowerCase();
const PREMIUM_SUBSCRIPTION_ADDRESS = (process.env.PREMIUM_SUBSCRIPTION_ADDRESS || "0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1").toLowerCase();
// Confirmed live via Blockscout's verified contract names during this feature's own build —
// not otherwise used as shared constants anywhere else in this backend yet.
const CORE_CLASH_TRADING_CARD_GAME_ADDRESS = "0xbb9ec09eab6d680e2a6c4794c34a9b3c0208fce2";
const CORE_CLASH_GAME_ADDRESS = "0x113129f0865058a840d7ad78a655735a590c7c03";
const CLUB_SPIN_VAULT_ADDRESS = "0x9043c8797b3a3babd877aeed3e3cc3baad2d53c2";
// Frontend user-initiated swaps go through this (confirmed live) — a different, more complex
// router than the simple one this backend's own buy-and-burn code uses internally (see
// pnlSplitExecutionScheduler.js / PlanetZephyros's autoBuyBackAndBurn.js). The simple router is
// included too for completeness, even though today only this app's own contracts (already covered
// by the Marketplace/PremiumSubscription entries below) call it.
const UNIVERSAL_ROUTER_ADDRESS = "0x2c12c8F15637b7A182DEc202816148A5E767DCEC".toLowerCase();
const SIMPLE_ELECTROSWAP_ROUTER_ADDRESS = "0x072D4706f9A383D5608BD14B09b41683cb95fFd7".toLowerCase();

const KNOWN_BURN_SOURCES = new Map([
  [PREMIUM_SUBSCRIPTION_ADDRESS, "PnL Statements"],
  [MARKETPLACE_ADDRESS, "ETN Subdomain Service"],
  [CORE_CLASH_TRADING_CARD_GAME_ADDRESS, "Core Clash"],
  [CORE_CLASH_GAME_ADDRESS, "Core Clash"],
  [CLUB_SPIN_VAULT_ADDRESS, "Core Clash"],
  [UNIVERSAL_ROUTER_ADDRESS, "Token Swaps"],
  [SIMPLE_ELECTROSWAP_ROUTER_ADDRESS, "Token Swaps"],
  ...(CORE_WETN_POOL_ADDRESS ? [[CORE_WETN_POOL_ADDRESS.toLowerCase(), "Token Swaps"]] : []),
]);

const dynamicNameCache = new Map(); // address (lowercase) -> label string | null, cached indefinitely — a contract's identity never changes

/** Best-effort verified contract name via Blockscout, for a tx.to this app doesn't already have a
 * curated label for. Never throws — a lookup failure just falls back to "Manual burn" rather than
 * blocking/dropping the alert over something this cosmetic. */
async function lookupDynamicLabel(address, explorerBaseUrl) {
  const key = address.toLowerCase();
  if (dynamicNameCache.has(key)) return dynamicNameCache.get(key);

  let label = null;
  try {
    const res = await fetch(`${explorerBaseUrl}/api/v2/addresses/${address}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      // A plain call directly to the CORE token contract itself (transfer()/burn() from an
      // ordinary wallet, not through any known app) is exactly what "Manual burn" means — showing
      // the token's own verified name here would be confusing, not clarifying.
      if (data.name && key !== CORE_TOKEN_ADDRESS?.toLowerCase()) label = data.name;
    }
  } catch {
    // swallow — see function comment
  }
  dynamicNameCache.set(key, label);
  return label;
}

/** Labels which mechanism triggered a burn, given the *transaction's* own destination contract
 * (not the raw Transfer event's donor — see this file's header comment on why). Falls back to
 * "Manual burn" when nothing else applies. */
export async function labelBurnSource(txTo, explorerBaseUrl) {
  if (!txTo) return "Manual burn";
  const key = txTo.toLowerCase();
  if (KNOWN_BURN_SOURCES.has(key)) return KNOWN_BURN_SOURCES.get(key);
  const dynamic = await lookupDynamicLabel(txTo, explorerBaseUrl);
  return dynamic || "Manual burn";
}
