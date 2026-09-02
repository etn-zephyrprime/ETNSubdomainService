import { ethers } from "ethers";

// Shared RPC endpoint selection + failover for every cache/watcher in this backend. Previously
// each file built its own `new ethers.JsonRpcProvider(RPC_URL, ...)` straight off a single
// RPC_URL env var — fine until that one endpoint's API key got disabled outright (Ankr: "API key
// disabled", json-rpc code -32051, rest code 403 — confirmed live, not a rate limit), which took
// every single one of them down at once with nothing to fall back to. Two prior incidents already
// hit this backend's RPC endpoint being the single point of failure (see dailyBlockStatsCache.js's
// and validatorRewardsCache.js's own header comments) — this is the fix that actually removes that
// single point, instead of just tuning load against it.
const PRIMARY_RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const SECONDARY_RPC_URL = process.env.RPC_URL_FALLBACK || "https://rpc.electroneum.com";

// Electroneum mainnet — same value as src/config.js's CHAIN_ID. Passed as a static network to
// the provider built here so it never does a live eth_chainId auto-detection handshake on
// startup — that handshake failing outright (not just being slow) is exactly what caused the
// "JsonRpcProvider failed to detect network and cannot start up" retry loop seen once already in
// this repo's history, against an endpoint under load.
const CHAIN_ID = 52014;
const network = ethers.Network.from(CHAIN_ID);

// How long to skip the primary entirely after it fails, before trying it again. Deliberately NOT
// implemented with ethers' own FallbackProvider — confirmed by reading its source
// (node_modules/ethers, provider-fallback.ts): its quorum mechanism tallies a provider's *error*
// as a legitimate, quorum-meeting result (by design, for its own "do enough decentralized nodes
// agree this call reverts" use case). With two equal-weight providers and the default/quorum-1
// config this needs, the primary's very first error alone already meets quorum and gets thrown
// immediately — the secondary is never even dispatched. That's consensus, not failover.
//
// This is a small hand-rolled alternative instead: try the primary, and if it fails, use the
// secondary for every subsequent call for COOLDOWN_MS before trying the primary again — a fully
// disabled key (this incident) fails every single request, forever, until someone fixes it
// manually, so without a cooldown every RPC call across the whole backend would silently pay one
// guaranteed-failing request to the dead primary first, for as long as the outage lasts.
const PRIMARY_COOLDOWN_MS = process.env.RPC_PRIMARY_COOLDOWN_MS
  ? parseInt(process.env.RPC_PRIMARY_COOLDOWN_MS, 10)
  : 60000;

class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(primaryUrl, secondaryUrl, options) {
    super(primaryUrl, network, options);
    this._secondaryUrl = secondaryUrl;
    this._primaryDownUntil = 0;
  }

  // Deliberately plain fetch(), NOT ethers' own FetchRequest (which the primary path above uses
  // via super._send()) — confirmed live that ethers' Node HTTP client (a raw http/https request
  // under the hood, see node_modules/ethers/utils/geturl.js) gets a 403 from this endpoint that
  // neither curl nor Node's native fetch() gets hitting the exact same URL, almost certainly a
  // TLS/HTTP client fingerprint check on their side rather than anything about the request
  // content itself. This is the one caller in this codebase that has to route around ethers' own
  // request layer for that reason — every other fetch() elsewhere here already used the native
  // one anyway (r2CacheProxyRouter.js, validatorRewardsCache.js, etc.), this is just the first
  // time it mattered for an ethers provider specifically.
  // A handful of retries with a short backoff for a non-ok HTTP response specifically (never for a
  // valid JSON-RPC error response, which callers handle themselves) — confirmed live: a burst of
  // concurrent calls to this endpoint (pnlIngestion.js's DeFi log scan, which fans out several
  // requests at once once the primary's cooldown routes everything here) can trip a transient 403,
  // which cleared on its own within a couple seconds on retry. This endpoint is a public node with
  // no published rate-limit contract, so a short retry is the only real option — there's no
  // documented threshold to stay under.
  async _sendViaSecondary(payload, attempt = 0) {
    const res = await fetch(this._secondaryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        return this._sendViaSecondary(payload, attempt + 1);
      }
      throw new Error(`secondary RPC server response ${res.status} ${res.statusText}`);
    }
    let resp = await res.json();
    if (!Array.isArray(resp)) resp = [resp];
    return resp;
  }

  async _send(payload) {
    if (Date.now() < this._primaryDownUntil) {
      return this._sendViaSecondary(payload);
    }

    try {
      const result = await super._send(payload);
      this._primaryDownUntil = 0; // a working call clears any earlier cooldown
      return result;
    } catch (primaryErr) {
      this._primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
      console.warn(`⚠️  Primary RPC failed, using secondary for ${PRIMARY_COOLDOWN_MS / 1000}s: ${primaryErr.message}`);
      return this._sendViaSecondary(payload); // let this reject naturally if it also fails — same
      // per-cycle try/catch-and-skip every cache/watcher here already has handles that, no need
      // to duplicate a second retry-primary-anyway path for what would be a rare double outage.
    }
  }
}

/**
 * Builds a provider for Electroneum mainnet that transparently fails over from RPC_URL (Ankr by
 * default) to RPC_URL_FALLBACK (Electroneum's own public RPC by default) on error. `options` is
 * passed straight to the underlying JsonRpcProvider — every existing caller's `{ batchMaxCount: 1 }`
 * (or no options at all) works exactly as before.
 */
export function createRpcProvider(options) {
  return new FailoverJsonRpcProvider(PRIMARY_RPC_URL, SECONDARY_RPC_URL, options);
}
