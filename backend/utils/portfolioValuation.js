// backend/utils/portfolioValuation.js
//
// Shared "what is this member's combined tracked-wallet portfolio worth in USD right now"
// computation — used by both portfolioAlertScheduler.js (threshold alerts) and
// portfolioDigestScheduler.js (daily summary), so the two features can never quietly disagree on
// what "portfolio value" means. Token pricing is now ElectroSwap's own official API FIRST — one
// batched call per wallet (see electroSwapApi.js's own header comment on why batching over this
// app's previous per-token on-chain reads) — falling back per-token to dexPriceQuote.js's on-chain
// ElectroSwap read (ETN leg, times the live etnPriceCache.js ETN/USD price) for anything
// ElectroSwap's API doesn't price (ELECTROSWAP_API_KEY not configured, the account is out of
// credits, or the specific token just isn't indexed there yet) — never a hard dependency on the new
// API, always the same coverage this app already had before it existed.
//
// Spam-token and NFT exclusion mirrors CoreTierPortfolio.jsx's own frontend total (isSpamTokenName,
// NFT type filtering) so a member sees the same total here as on the dashboard, not two subtly
// different numbers for "the same" figure.
import { ethers } from "ethers";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getBatchTokenPrices } from "./electroSwapApi.js";
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

/**
 * Combined USD value of every wallet `ownerWallet`'s Core tier features cover — their own
 * connected wallet plus up to 3 explicitly tracked ones (see trackedWallets.js's
 * getCoveredWallets) — ETN + every priced fungible token holding, up to
 * MAX_PRICED_TOKENS_PER_WALLET per wallet, PLUS the live value of any currently-open yield-farm/
 * staking position (see defiPositionValuation.js) — funds moved into one of those contracts don't
 * show up as a wallet token balance at all otherwise. `hasUnpriced` mirrors CoreTierPortfolio.jsx's own
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

    // One batched ElectroSwap call for every fungible holding in this wallet (up to
    // MAX_PRICED_TOKENS_PER_WALLET, which is also ElectroSwap's own per-call max — the whole
    // wallet fits in a single request). Returns an empty Map (never throws) if ELECTROSWAP_API_KEY
    // isn't configured, so the fallback loop below is exactly this app's pre-existing behavior on
    // any deployment that hasn't set the key yet.
    const electroSwapPrices = await getBatchTokenPrices(priced.map((tb) => tb.token.address));

    for (const tb of priced) {
      const addressLc = tb.token.address.toLowerCase();
      const amount = parseFloat(ethers.formatUnits(tb.value, Number(tb.token?.decimals || 18)));

      const electroSwapUsd = electroSwapPrices.get(addressLc);
      if (electroSwapUsd != null) {
        totalUsd += amount * electroSwapUsd;
        continue;
      }

      // Fall back to the on-chain read for anything ElectroSwap didn't price — same behavior this
      // app had before ElectroSwap's API existed.
      if (etnUsd == null) {
        hasUnpriced = true;
        continue;
      }
      try {
        const tokenEtnPrice = await getTokenEtnPrice(provider, tb.token.address);
        if (tokenEtnPrice == null) {
          hasUnpriced = true;
          continue;
        }
        totalUsd += amount * tokenEtnPrice * etnUsd;
      } catch (err) {
        console.warn(`⚠️  Portfolio valuation: price lookup failed for ${tb.token?.address}:`, err.message);
        hasUnpriced = true;
      }
    }

    // Funds currently staked/farmed at a known YieldFarm/CoreAscension contract don't show up as a
    // wallet token balance at all (they've moved into that contract) — without this, they'd simply
    // be invisible from the portfolio total. See defiPositionValuation.js's own header comment for
    // why this is always a live on-chain read, never reconstructed from ingested event history.
    try {
      const defi = await getOpenDefiPositionsUsd(w.address);
      if (defi.totalUsd != null) totalUsd += Number(defi.totalUsd);
      if (defi.hasUnpriced) hasUnpriced = true;
    } catch (err) {
      console.warn(`⚠️  Portfolio valuation: DeFi position lookup failed for ${w.address}:`, err.message);
      hasUnpriced = true;
    }
  }

  return { totalUsd, hasUnpriced };
}
