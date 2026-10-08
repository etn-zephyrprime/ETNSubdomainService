// backend/utils/knownContractLabels.js
//
// Best-effort human label for a contract address a transfer counterparty happens to be — built
// for recentActivityService.js's own feed, which otherwise shows a bare "Sent X to 0xabc..." for
// a genuine contract interaction (a subscription payment, a liquidity-pool deposit that
// pnlIngestion.js's own stricter FIFO/cost-basis decomposition deliberately declined to unpack —
// see detectAndRecordV3PositionEvent's own comment on why a non-direct wallet<->pool leg is
// skipped rather than guessed at) just because that's genuinely all a plain transfer row knows.
//
// Same two-tier shape as burnSourceLabels.js (a curated static map first for this app's own known
// contracts, Blockscout's own verified contract name as the fallback for everything else) —
// that file is scoped to burn-source classification specifically and isn't reused directly, but
// the pattern is proven there already: a cheap static check before ever reaching for a network
// call, and the network call itself cached indefinitely (a contract's identity never changes).
import { fetchBlockscoutJson } from "./blockscoutClient.js";

// Same fallback literal burnSourceLabels.js already hardcodes for this exact contract.
const PREMIUM_SUBSCRIPTION_ADDRESS = (process.env.PREMIUM_SUBSCRIPTION_ADDRESS || "0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1").toLowerCase();
// Same constant pnlIngestion.js exports as POSITION_MANAGER_ADDRESS — duplicated as a literal
// rather than imported to avoid pulling pnlIngestion.js's own (much heavier) module graph into
// this small, display-only utility purely for one constant.
const V3_POSITION_MANAGER_ADDRESS = "0x3a7f64c57433555b23dac4409a0ac7e84275398d";

const KNOWN_LABELS = new Map([
  [PREMIUM_SUBSCRIPTION_ADDRESS, "Core Tier Subscription"],
  [V3_POSITION_MANAGER_ADDRESS, "ElectroSwap Liquidity Position"],
]);

const dynamicNameCache = new Map(); // address (lowercase) -> label string | null, cached indefinitely

/** Best-effort human label for `address` if it's a contract this app recognizes (the static map
 * above) or has a verified name on Blockscout — null for an ordinary wallet or an unverified
 * contract, same "omit rather than fake" convention as this app's pricing code; the caller falls
 * back to its own short-hash/ENS display in that case. Never throws. */
export async function labelKnownAddress(address) {
  if (!address) return null;
  const key = address.toLowerCase();
  if (KNOWN_LABELS.has(key)) return KNOWN_LABELS.get(key);
  if (dynamicNameCache.has(key)) return dynamicNameCache.get(key);

  let label = null;
  try {
    const data = await fetchBlockscoutJson(`/addresses/${address}`);
    if (data?.is_contract && data?.name) label = data.name;
  } catch {
    // Best-effort only — a lookup failure just leaves this one address unlabeled this time, not
    // cached as permanently unlabeled (see dynamicNameCache.set below, only reached on success).
    return null;
  }
  dynamicNameCache.set(key, label);
  return label;
}

/** Resolves every DISTINCT address in `addresses` in one batch (deduped, parallel, each one cached
 * forever after its first resolution) — the shape recentActivityService.js actually needs: label
 * a whole feed's worth of counterparties without resolving the same contract repeatedly across
 * many activity items. Returns a Map(lowercased address -> label string), omitting any address
 * that resolved to null (an ordinary wallet or unverified contract) — absence IS the "no label"
 * signal, so the caller just checks `.has()`/`.get()` rather than handling a null entry specially. */
export async function labelKnownAddresses(addresses) {
  const distinct = [...new Set((addresses || []).filter(Boolean).map((a) => a.toLowerCase()))];
  const results = await Promise.all(distinct.map((a) => labelKnownAddress(a)));
  const map = new Map();
  distinct.forEach((address, i) => {
    if (results[i]) map.set(address, results[i]);
  });
  return map;
}
