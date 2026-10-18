// backend/services/ignoredAssets.js
//
// Junk assets the PnL valuation skips instead of trying to price. Each one used to cost a price
// lookup per valued day (up to 365 in a history backfill) — usually a doomed one, since these never
// have a real market — and if it did resolve, its "value" was noise rather than holdings.
//   - any ERC-20 token or NFT collection whose name or symbol contains "test" (any case) or starts
//     with "TSA" (the owner's own test items) — see isTestNamedToken, which ingestion also uses;
//   - an ERC-20 token with fewer than MIN_HOLDERS holders. That rule is only applied where there's
//     no live price for the token (see valueInventoryAtTimestamp): V2 LP pair tokens often have
//     only a handful of holders but are valued from live pool reserves, and must not drop out.
// Metadata comes from Blockscout's /tokens/{address}, once per collection/token per process.
// A lookup that fails is treated as "not junk" — never hide a real holding over a Blockscout blip.
// Same value as pnlEventBuilder.js's NATIVE_SENTINEL — not imported, since that file imports this one.
const NATIVE_SENTINEL = "NATIVE";

const BLOCKSCOUT = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const MIN_HOLDERS = 5;
const TEST_PATTERNS = [/test/i, /^TSA/];

/** True if a token/collection's name or symbol marks it as a test item. Also used by ingestion
 * (pnlIngestion.js) to never record plain transfers of these in the first place. */
export function isTestNamedToken(token) {
  const { name, symbol } = token || {};
  return [name, symbol].some((v) => TEST_PATTERNS.some((re) => re.test(String(v || "").trim())));
}

const infoCache = new Map(); // lowercase address -> Promise<{ isTest, holders } | null>

function fetchTokenInfo(address) {
  const key = address.toLowerCase();
  if (!infoCache.has(key)) {
    infoCache.set(
      key,
      (async () => {
        try {
          const res = await fetch(`${BLOCKSCOUT}/tokens/${key}`, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) return null;
          const t = await res.json();
          const holders = Number(t.holders_count ?? t.holders);
          return {
            isTest: isTestNamedToken(t),
            holders: Number.isFinite(holders) ? holders : null,
          };
        } catch {
          return null;
        }
      })().then((info) => {
        // Don't remember a failure for the whole process — the next caller gets a fresh try.
        if (!info) infoCache.delete(key);
        return info;
      })
    );
  }
  return infoCache.get(key);
}

/** True if this FIFO lot key should be left out of valuation. `hasLivePrice` turns the holder-count
 * rule off (see the header comment). Native ETN is never ignored. NFT lot keys
 * ("collection:tokenId") are judged by their collection's name/symbol only. */
export async function isIgnoredAsset(lotKey, { hasLivePrice = false } = {}) {
  if (!lotKey || lotKey === NATIVE_SENTINEL) return false;
  const [address, tokenId] = String(lotKey).split(":");
  const info = await fetchTokenInfo(address);
  if (!info) return false;
  if (info.isTest) return true;
  if (tokenId !== undefined || hasLivePrice) return false;
  return info.holders != null && info.holders < MIN_HOLDERS;
}
