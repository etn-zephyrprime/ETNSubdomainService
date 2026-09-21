// backend/utils/portfolioValuation.js
//
// Shared "what is this member's combined tracked-wallet portfolio worth in USD right now"
// computation — used by both portfolioAlertScheduler.js (threshold alerts) and
// portfolioDigestScheduler.js (daily summary, each looping over every subscribed member's wallet
// in one tick), so the two features can never quietly disagree on what "portfolio value" means.
// Token pricing is now ElectroSwap's own official API FIRST — one batched call per wallet, through
// electroSwapPriceCache.js's shared cache (so a token more than one member happens to hold, priced
// already this tick by an earlier wallet's own call, costs nothing the second time — see that
// file's own header comment on why the actual saving here is real but opportunistic, not free) —
// falling back per-token to dexPriceQuote.js's on-chain ElectroSwap read (ETN leg, times the live
// etnPriceCache.js ETN/USD price) for anything ElectroSwap's API doesn't price (ELECTROSWAP_API_KEY
// not configured, the account is out of credits, or the specific token just isn't indexed there
// yet) — never a hard dependency on the new API, always the same coverage this app already had
// before it existed.
//
// Spam-token and NFT exclusion mirrors CoreTierPortfolio.jsx's own frontend total (isSpamTokenName,
// NFT type filtering) so a member sees the same total here as on the dashboard, not two subtly
// different numbers for "the same" figure.
import { ethers } from "ethers";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getCachedBatchTokenPrices } from "./electroSwapPriceCache.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { fetchBlockscoutJson } from "./blockscoutClient.js";
import { getOpenDefiPositionsUsd } from "../services/defiPositionValuation.js";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
// MUST stay byte-for-byte in sync with src/dashboard/utils/format.js's SPAM_NAME_PATTERN — kept as
// its own small copy here rather than importing a frontend module from the backend (no shared
// build step between them, same reasoning as pnlStatementGenerator.js's own hand-synced THEME
// constant). Confirmed drifted from that canonical pattern once already (this copy checked for a
// URL/TLD in the name, the real one is a plain "dead"/"test"/"token" substring match) — fixed here
// to match exactly; if the frontend pattern ever changes, update this too.
function isSpamTokenName(name) {
  return /dead|test|token/i.test(name || "");
}
// Same reasoning/value as CoreTierPortfolio.jsx's own MAX_PRICED_HOLDINGS — bounds worst-case
// per-wallet RPC volume for a wallet holding a large number of distinct tokens (airdropped spam in
// particular), not just the GeckoTerminal discovery burst dexPriceQuote.js already caches away.
const MAX_PRICED_TOKENS_PER_WALLET = 50;

// LAST-KNOWN-GOOD values. A price lookup can fail for a minute or ten (ElectroSwap's key gets rate-limited or
// suspended and the shared breaker blanks every caller; the GeckoTerminal fallback is rate-limited too). Before
// this, a token that couldn't be priced simply contributed $0 — and a staked position that couldn't be valued
// vanished — so the daily summary's total could swing by thousands of dollars from one bad minute. Now a token
// or DeFi position that can't be valued right now is carried at its last successfully-valued figure (up to
// STALE_MAX_MS old) instead of dropping to zero. In memory only: a restart starts empty, and the digest
// scheduler handles that case by waiting for a complete valuation rather than trusting a partial one.
const STALE_MAX_MS = 48 * 60 * 60 * 1000;
const lastGoodTokenUsd = new Map(); // lowercased token address -> { usd (per token), at }
const lastGoodDefiUsd = new Map(); // lowercased wallet -> { usd, at }
const fresh = (entry) => entry && Date.now() - entry.at <= STALE_MAX_MS;

/**
 * Combined USD value of every wallet `ownerWallet`'s Core tier features cover — their own
 * connected wallet plus up to 3 explicitly tracked ones (see trackedWallets.js's
 * getCoveredWallets) — ETN + every priced fungible token holding, up to
 * MAX_PRICED_TOKENS_PER_WALLET per wallet, PLUS the live value of any currently-open yield-farm/
 * staking position (see defiPositionValuation.js) — funds moved into one of those contracts don't
 * show up as a wallet token balance at all otherwise. `usedStale` is true when some figure is a carried-forward last-known-good value (see lastGoodTokenUsd) rather than a live one. `hasUnpriced` mirrors CoreTierPortfolio.jsx's own
 * convention: true when at least one non-zero holding couldn't be priced (ETN/USD cache not
 * ready, a token has no ElectroSwap pool, or the per-wallet cap was hit), meaning the real total
 * is AT LEAST this much, not exactly this much. The `{ totalUsd: 0, hasUnpriced: false }` empty
 * case is now unreachable in practice (getCoveredWallets always returns at least the owner's own
 * wallet) — kept as a defensive fallback, not a real "no wallets" state anymore.
 */
export async function getPortfolioUsdValue(provider, ownerWallet) {
  const tracked = await getCoveredWallets(ownerWallet);
  if (tracked.length === 0) return { totalUsd: 0, hasUnpriced: false };

  const priceCache = await getEtnPriceCache();
  const etnUsd = priceCache?.usd ?? null;
  let hasUnpriced = etnUsd == null;
  let usedStale = false; // some figure below is a carried-forward last-known-good value, not a live one

  let totalUsd = 0;
  for (const w of tracked) {
    let addressInfo;
    let tokenBalances = [];
    try {
      [addressInfo, tokenBalances] = await Promise.all([
        fetchBlockscoutJson(`/addresses/${w.address}`),
        fetchBlockscoutJson(`/addresses/${w.address}/token-balances`).then((r) => (Array.isArray(r) ? r : r?.items || [])),
      ]);
    } catch (err) {
      console.warn(`⚠️  Portfolio valuation: fetch failed for ${w.address}:`, err.message);
      hasUnpriced = true;
      continue;
    }

    const etnAmount = parseFloat(ethers.formatEther(addressInfo?.coin_balance || "0"));
    if (etnUsd != null) totalUsd += etnAmount * etnUsd;
    else if (etnAmount > 0) hasUnpriced = true;

    const fungible = tokenBalances.filter(
      (tb) => !NFT_TOKEN_TYPES.has(tb.token?.type) && !isSpamTokenName(tb.token?.name) && BigInt(tb.value || 0) > 0n
    );
    if (fungible.length > MAX_PRICED_TOKENS_PER_WALLET) hasUnpriced = true;
    const priced = fungible.slice(0, MAX_PRICED_TOKENS_PER_WALLET);

    // One batched ElectroSwap call (via electroSwapPriceCache.js's shared cache — so a token
    // several members happen to hold, priced already this tick by another wallet's own call here,
    // costs nothing the second time) for every fungible holding in this wallet, up to
    // MAX_PRICED_TOKENS_PER_WALLET (also ElectroSwap's own per-call max — the whole wallet fits in
    // a single request). Returns an empty Map (never throws) if ELECTROSWAP_API_KEY isn't
    // configured, so the fallback loop below is exactly this app's pre-existing behavior on any
    // deployment that hasn't set the key yet.
    const electroSwapPrices = await getCachedBatchTokenPrices(priced.map((tb) => tb.token.address));

    for (const tb of priced) {
      const addressLc = tb.token.address.toLowerCase();
      const amount = parseFloat(ethers.formatUnits(tb.value, Number(tb.token?.decimals || 18)));

      const electroSwapPrice = electroSwapPrices.get(addressLc)?.usd;
      if (electroSwapPrice != null) {
        totalUsd += amount * electroSwapPrice;
        lastGoodTokenUsd.set(addressLc, { usd: electroSwapPrice, at: Date.now() });
        continue;
      }

      // Carries a token at its last known price when it can't be priced now (see lastGoodTokenUsd above).
      const priceUnavailable = () => {
        const last = lastGoodTokenUsd.get(addressLc);
        if (fresh(last)) {
          totalUsd += amount * last.usd;
          usedStale = true;
        } else {
          hasUnpriced = true;
        }
      };

      // Fall back to the on-chain read for anything ElectroSwap didn't price — same behavior this
      // app had before ElectroSwap's API existed.
      if (etnUsd == null) {
        priceUnavailable();
        continue;
      }
      try {
        // skipElectroSwap: true — this token was already checked against ElectroSwap's BATCH
        // endpoint just above and came back absent; retrying the SINGLE endpoint here would almost
        // certainly fail again too (same underlying pricing data), just at a real credit cost for a
        // near-guaranteed miss. Falls straight to the on-chain path.
        const tokenEtnPrice = await getTokenEtnPrice(provider, tb.token.address, { skipElectroSwap: true });
        if (tokenEtnPrice == null) {
          priceUnavailable();
          continue;
        }
        totalUsd += amount * tokenEtnPrice * etnUsd;
        lastGoodTokenUsd.set(addressLc, { usd: tokenEtnPrice * etnUsd, at: Date.now() });
      } catch (err) {
        console.warn(`⚠️  Portfolio valuation: price lookup failed for ${tb.token?.address}:`, err.message);
        priceUnavailable();
      }
    }

    // Funds currently staked/farmed at a known YieldFarm/CoreAscension contract don't show up as a
    // wallet token balance at all (they've moved into that contract) — without this, they'd simply
    // be invisible from the portfolio total. See defiPositionValuation.js's own header comment for
    // why this is always a live on-chain read, never reconstructed from ingested event history.
    try {
      const defi = await getOpenDefiPositionsUsd(w.address);
      const defiUsd = defi.totalUsd != null ? Number(defi.totalUsd) : 0;
      const key = w.address.toLowerCase();
      if (!defi.hasUnpriced) {
        // A complete valuation — remember it (including "nothing staked", so a closed position isn't carried on).
        lastGoodDefiUsd.set(key, { usd: defiUsd, at: Date.now() });
        totalUsd += defiUsd;
      } else {
        // Incomplete this time (a position couldn't be read/priced). Never report LESS than what we last knew
        // it to be worth just because a lookup failed.
        const last = lastGoodDefiUsd.get(key);
        if (fresh(last) && last.usd > defiUsd) {
          totalUsd += last.usd;
          usedStale = true;
        } else {
          totalUsd += defiUsd;
          hasUnpriced = true;
        }
      }
    } catch (err) {
      console.warn(`⚠️  Portfolio valuation: DeFi position lookup failed for ${w.address}:`, err.message);
      const last = lastGoodDefiUsd.get(w.address.toLowerCase());
      if (fresh(last)) {
        totalUsd += last.usd;
        usedStale = true;
      } else {
        hasUnpriced = true;
      }
    }
  }

  return { totalUsd, hasUnpriced, usedStale };
}
