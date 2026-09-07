// backend/utils/portfolioValuation.js
//
// Shared "what is this member's combined tracked-wallet portfolio worth in USD right now"
// computation — used by both portfolioAlertScheduler.js (threshold alerts) and
// portfolioDigestScheduler.js (daily summary), so the two features can never quietly disagree on
// what "portfolio value" means. Same pricing sources as tokenPriceAlertScheduler.js: ETN's own
// value via the live etnPriceCache.js price, and every held token's value via dexPriceQuote.js's
// on-chain ElectroSwap read (ETN leg) times that same ETN/USD price — zero GeckoTerminal
// involvement in the recurring poll itself (a token's FIRST-ever price lookup anywhere in this
// backend still resolves its pool via GeckoTerminal once, per dexPriceQuote.js's own header
// comment — after that it's cached forever and this is pure on-chain reads).
//
// Spam-token and NFT exclusion mirrors CoreTierPortfolio.jsx's own frontend total (isSpamTokenName,
// NFT type filtering) so a member sees the same total here as on the dashboard, not two subtly
// different numbers for "the same" figure.
import { ethers } from "ethers";
import { getActiveTrackedWallets } from "../db/trackedWallets.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { fetchBlockscoutJson } from "./blockscoutClient.js";

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
 * Combined USD value of every wallet `ownerWallet` currently actively tracks — ETN + every priced
 * fungible token holding, up to MAX_PRICED_TOKENS_PER_WALLET per wallet. `hasUnpriced` mirrors
 * CoreTierPortfolio.jsx's own convention: true when at least one non-zero holding couldn't be
 * priced (ETN/USD cache not ready, a token has no ElectroSwap pool, or the per-wallet cap was hit),
 * meaning the real total is AT LEAST this much, not exactly this much. Returns
 * `{ totalUsd: 0, hasUnpriced: false }` for an owner with no tracked wallets — a real, valid zero.
 */
export async function getPortfolioUsdValue(provider, ownerWallet) {
  const tracked = await getActiveTrackedWallets(ownerWallet);
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

    for (const tb of fungible.slice(0, MAX_PRICED_TOKENS_PER_WALLET)) {
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
        const amount = parseFloat(ethers.formatUnits(tb.value, Number(tb.token?.decimals || 18)));
        totalUsd += amount * tokenEtnPrice * etnUsd;
      } catch (err) {
        console.warn(`⚠️  Portfolio valuation: price lookup failed for ${tb.token?.address}:`, err.message);
        hasUnpriced = true;
      }
    }
  }

  return { totalUsd, hasUnpriced };
}
