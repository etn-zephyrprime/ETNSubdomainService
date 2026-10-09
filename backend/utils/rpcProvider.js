import { ethers } from "ethers";

// Shared RPC endpoint selection + failover for every cache/watcher in this backend. Previously
// each file built its own `new ethers.JsonRpcProvider(RPC_URL, ...)` straight off a single
// RPC_URL env var — fine until that one endpoint's API key got disabled outright (Ankr: "API key
// disabled", json-rpc code -32051, rest code 403 — confirmed live, not a rate limit), which took
// every single one of them down at once with nothing to fall back to. Two prior incidents already
// hit this backend's RPC endpoint being the single point of failure (see dailyBlockStatsCache.js's
// and validatorRewardsCache.js's own header comments) — this is the fix that actually removes that
// single point, instead of just tuning load against it.
//
// Three tiers now, not two — added after Ankr AND the Electroneum public node both struggled at
// once during a real wallet's unusually large cold-start DeFi scan (confirmed live: the primary
// timing out repeatedly, which routes everything to the secondary for its own 60s cooldown window,
// pushed enough sustained load at the secondary to trip ITS OWN rejection too — a genuine double
// failure, not just the usual single-endpoint blip this file already handled).
//
// Priority: Ankr, then Electroneum's own node, then thirdweb LAST — thirdweb is placed last
// (originally tried second) after its own dashboard showed its free plan's hard limit is just
// 10 RPS, with this backend's real aggregate usage (every cache/watcher sharing this one provider
// factory, not just one script) peaking at 189 RPS — 37.8% of requests already being rate-limited
// even with an API key configured. Electroneum's own node has shown transient 403s under burst
// load before, but never an explicit measured cap anywhere near that low, making it the safer
// second choice until thirdweb's plan is upgraded (or this ever gets its own dedicated key headroom
// sized for real aggregate backend usage, not just one script's share of it).
const PRIMARY_RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const FALLBACK_RPC_URL_1 = process.env.RPC_URL_FALLBACK || "https://rpc.electroneum.com";
const FALLBACK_RPC_URL_2 = process.env.RPC_URL_FALLBACK_2 || "https://52014.rpc.thirdweb.com";

// Electroneum mainnet — same value as src/config.js's CHAIN_ID. Passed as a static network to
// the provider built here so it never does a live eth_chainId auto-detection handshake on
// startup — that handshake failing outright (not just being slow) is exactly what caused the
// "JsonRpcProvider failed to detect network and cannot start up" retry loop seen once already in
// this repo's history, against an endpoint under load.
const CHAIN_ID = 52014;
const network = ethers.Network.from(CHAIN_ID);

// How long to skip an endpoint entirely after it fails, before trying it again. Deliberately NOT
// implemented with ethers' own FallbackProvider — confirmed by reading its source
// (node_modules/ethers, provider-fallback.ts): its quorum mechanism tallies a provider's *error*
// as a legitimate, quorum-meeting result (by design, for its own "do enough decentralized nodes
// agree this call reverts" use case). With equal-weight providers and the default/quorum-1 config
// this needs, the first one's very first error alone already meets quorum and gets thrown
// immediately — the others are never even dispatched. That's consensus, not failover.
//
// This is a small hand-rolled alternative instead: try each configured endpoint in priority order,
// skipping any still in its own cooldown, for COOLDOWN_MS after it last failed — a fully disabled
// key (the incident that started this file) fails every single request, forever, until someone
// fixes it manually, so without a cooldown every RPC call across the whole backend would silently
// pay one guaranteed-failing request to the dead endpoint first, for as long as the outage lasts.
const PRIMARY_COOLDOWN_MS = process.env.RPC_PRIMARY_COOLDOWN_MS
  ? parseInt(process.env.RPC_PRIMARY_COOLDOWN_MS, 10)
  : 60000;

// Bounds how long ANY single RPC call — on any of the three endpoints — can hang before failing
// out to the next one (or, if all are down, to the caller's own catch/fallback). Confirmed live as
// a real gap: ethers' own FetchRequest defaults to a 300-SECOND (5 minute) timeout on the primary
// path, but a bare fetch() used to have no timeout at all — an unresponsive (not just erroring)
// endpoint could hang a call, and everything awaiting it, forever. Traced to a real symptom: a
// demo-generation run sat for hours with near-zero CPU use (confirmed via `ps`), and a genuine,
// reserve-backed LP position silently never made it into a wallet's results — probeV2Pool's own
// catch swallowed whatever failed here with no trace (see that function's own comment, now
// logged). 20s comfortably covers a slow-but-live node; anything longer than that is
// indistinguishable from "not responding" for this app's purposes, and every caller here already
// has its own catch/fallback for a failed call.
const RPC_TIMEOUT_MS = process.env.RPC_TIMEOUT_MS ? parseInt(process.env.RPC_TIMEOUT_MS, 10) : 20000;

// Electroneum's own public node needs a plain fetch() rather than ethers' own request layer —
// confirmed live that ethers' Node HTTP client (a raw http/https request under the hood, see
// node_modules/ethers/utils/geturl.js) gets a 403 from this endpoint that neither curl nor Node's
// native fetch() gets hitting the exact same URL, almost certainly a TLS/HTTP client fingerprint
// check on their side rather than anything about the request content itself. Confirmed live that
// Ankr and thirdweb do NOT need this workaround — a normal ethers sub-provider talks to both fine.
const PLAIN_FETCH_URLS = new Set(["https://rpc.electroneum.com"]);

class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(primaryUrl, fallbackUrls, options) {
    // A FetchRequest (not a plain string) so .timeout below actually applies — JsonRpcProvider
    // wraps a bare string URL in `new FetchRequest(url)` itself with no way to configure it
    // afterward, so the request object has to be built here instead.
    const primaryRequest = new ethers.FetchRequest(primaryUrl);
    primaryRequest.timeout = RPC_TIMEOUT_MS;
    super(primaryRequest, network, options);

    // index 0 is always this instance itself (via super._send, the primary); indexes 1..N are
    // `fallbackUrls`, in the exact priority order given. A fallback that doesn't need the plain-
    // fetch workaround gets its OWN real ethers provider (built once, reused for this instance's
    // whole life, same as the primary's own super-managed one) so it benefits from ethers' own
    // request handling (retries, JSON-RPC error shaping) rather than a bare fetch; one that DOES
    // need the workaround (Electroneum's node) gets none — _sendViaPlainFetch handles it directly.
    this._fallbacks = fallbackUrls.map((url) => {
      if (PLAIN_FETCH_URLS.has(url)) return { url, plainFetch: true, provider: null };
      const req = new ethers.FetchRequest(url);
      req.timeout = RPC_TIMEOUT_MS;
      return { url, plainFetch: false, provider: new ethers.JsonRpcProvider(req, network, { staticNetwork: network, ...options }) };
    });
    this._downUntil = new Array(1 + this._fallbacks.length).fill(0);
  }

  // A handful of retries with a short backoff for a non-ok HTTP response specifically (never for a
  // valid JSON-RPC error response, which callers handle themselves) — confirmed live: a burst of
  // concurrent calls to Electroneum's node (pnlIngestion.js's DeFi log scan, which fans out several
  // requests at once once an earlier endpoint's cooldown routes everything here) can trip a
  // transient 403, which cleared on its own within a couple seconds on retry. This is a public node
  // with no published rate-limit contract, so a short retry is the only real option — there's no
  // documented threshold to stay under.
  async _sendViaPlainFetch(url, payload, attempt = 0) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS), // see RPC_TIMEOUT_MS's own comment — this call had no timeout at all before
    });
    if (!res.ok) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        return this._sendViaPlainFetch(url, payload, attempt + 1);
      }
      throw new Error(`fallback RPC server response ${res.status} ${res.statusText}`);
    }
    let resp = await res.json();
    if (!Array.isArray(resp)) resp = [resp];
    return resp;
  }

  async _sendAtIndex(index, payload) {
    if (index === 0) return super._send(payload);
    const fb = this._fallbacks[index - 1];
    return fb.plainFetch ? this._sendViaPlainFetch(fb.url, payload) : fb.provider._send(payload);
  }

  _label(index) {
    return index === 0 ? "primary" : `fallback #${index} (${this._fallbacks[index - 1].url})`;
  }

  async _send(payload) {
    const now = Date.now();
    const total = 1 + this._fallbacks.length;
    // Priority order, skipping anything still in its own cooldown — but if that would skip EVERY
    // endpoint (a genuine all-down moment), try them anyway in priority order rather than failing
    // with nothing attempted at all.
    let order = [];
    for (let i = 0; i < total; i++) if (now >= this._downUntil[i]) order.push(i);
    if (order.length === 0) order = Array.from({ length: total }, (_, i) => i);

    let lastErr;
    for (let pos = 0; pos < order.length; pos++) {
      const index = order[pos];
      try {
        const result = await this._sendAtIndex(index, payload);
        this._downUntil[index] = 0; // a working call clears any earlier cooldown
        return result;
      } catch (err) {
        this._downUntil[index] = now + PRIMARY_COOLDOWN_MS;
        const more = pos < order.length - 1 ? `, trying next for ${PRIMARY_COOLDOWN_MS / 1000}s` : "";
        console.warn(`⚠️  ${this._label(index)} RPC failed${more}: ${err.message}`);
        lastErr = err;
      }
    }
    throw lastErr; // every endpoint failed — let this reject naturally, same as before
  }
}

/**
 * Builds a provider for Electroneum mainnet that transparently fails over, in priority order,
 * from RPC_URL (Ankr by default) to RPC_URL_FALLBACK (thirdweb by default) to RPC_URL_FALLBACK_2
 * (Electroneum's own public node by default) on error. `options` is passed straight to the
 * underlying JsonRpcProvider — every existing caller's `{ batchMaxCount: 1 }` (or no options at
 * all) works exactly as before.
 */
export function createRpcProvider(options) {
  return new FailoverJsonRpcProvider(PRIMARY_RPC_URL, [FALLBACK_RPC_URL_1, FALLBACK_RPC_URL_2], options);
}

/**
 * A plain provider on the PRIMARY endpoint only — no failover, and a long request timeout. For heavy
 * archive-state reads (etnBridge.js's backfill reads contract state at ~930 historical blocks): the public
 * fallback nodes don't serve old state ("missing revert data") and rate-limit bursts (403), so failing
 * over mid-backfill just turns one slow call into a failed backfill — and each failover also logs a
 * "Primary RPC failed" line. A slow archive call should be retried against the same node instead.
 */
export function createArchiveRpcProvider(options) {
  const request = new ethers.FetchRequest(PRIMARY_RPC_URL);
  request.timeout = process.env.RPC_ARCHIVE_TIMEOUT_MS ? parseInt(process.env.RPC_ARCHIVE_TIMEOUT_MS, 10) : 60000;
  return new ethers.JsonRpcProvider(request, network, { staticNetwork: network, ...options });
}
